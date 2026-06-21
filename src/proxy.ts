import * as http from "node:http";
import * as https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  ProxyConfig,
  ProxyServer,
  RouteResult,
  AttemptResult,
  CreateProxyOpts,
} from "./types.js";
import { resolveConfig, resolvePort } from "./config.js";
import { applyPrefillFix, modelNeedsFix } from "./prefill-fix.js";
import {
  extractThinkingProps,
  formatThinkingLog,
  applyThinkingRestore,
} from "./thinking-restore.js";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

const RETRY_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

function flattenHeaders(
  headers: IncomingMessage["headers"],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v !== undefined) out[k] = Array.isArray(v) ? v[0] : v;
  }
  return out;
}

function logFailure(
  tag: string,
  method: string | undefined,
  path: string,
  clientHeaders: Record<string, string>,
  upstreamHeaders: Record<string, string>,
  reqBody: Buffer | null,
  resHeaders: Record<string, string> | null,
  resBody: Buffer | null,
  resStatus: number | null,
  reason: string,
): void {
  const clientHeadersStr = JSON.stringify(clientHeaders, null, 2);
  const upstreamHeadersStr = JSON.stringify(upstreamHeaders, null, 2);
  const reqBodyStr =
    reqBody && reqBody.length
      ? reqBody.toString("utf8").slice(0, 4096)
      : "(empty)";
  const resHeadersStr = resHeaders
    ? JSON.stringify(resHeaders, null, 2)
    : "(no response)";
  const resBodyStr =
    resBody && resBody.length
      ? resBody.toString("utf8").slice(0, 4096)
      : "(empty)";

  console.error(
    `[vsllm-proxy] ${tag} FAILURE ${method ?? "?"} ${path}\n` +
      `  reason: ${reason}\n` +
      `  status: ${resStatus ?? "N/A"}\n` +
      `  client request headers:\n  ${clientHeadersStr}\n` +
      `  upstream request headers:\n  ${upstreamHeadersStr}\n` +
      `  request body:\n  ${reqBodyStr}\n` +
      `  response headers:\n  ${resHeadersStr}\n` +
      `  response body:\n  ${resBodyStr}`,
  );
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function readStreamBody(stream: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

function respond(
  res: ServerResponse,
  status: number,
  obj: Record<string, unknown>,
): void {
  if (res.headersSent || res.writableEnded) return;
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
  });
  res.end(body);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function createProxyServer(opts: CreateProxyOpts = {}): ProxyServer {
  const config = resolveConfig(opts);

  function resolveAuth(req: IncomingMessage): string | null {
    const hdr = req.headers["authorization"];
    if (hdr) return hdr;
    if (config.upstreamApiKey) return `Bearer ${config.upstreamApiKey}`;
    return null;
  }

  function buildUpstreamHeaders(
    req: IncomingMessage,
    auth: string | null,
    bodyLen: number,
  ): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (HOP_BY_HOP.has(k.toLowerCase())) continue;
      if (v !== undefined) out[k] = Array.isArray(v) ? v[0] : v;
    }
    out["host"] = config.upstreamHost;
    if (auth) out["authorization"] = auth;
    if (bodyLen > 0) out["content-length"] = String(bodyLen);
    if (!out["accept"]) out["accept"] = "application/json";
    return out;
  }

  function attemptOnce(
    req: IncomingMessage,
    res: ServerResponse,
    upstreamPath: string,
    body: Buffer | null,
  ): Promise<AttemptResult> {
    const upstream = new URL(upstreamPath, config.upstreamBaseUrl);
    const auth = resolveAuth(req);
    if (!auth) {
      respond(res, 401, {
        error: {
          message:
            "No API key. Supply an Authorization: Bearer <key> header or set upstreamApiKey in config.json.",
          type: "auth_error",
        },
      });
      return Promise.resolve({ ok: true, committed: true });
    }

    const outHeaders = buildUpstreamHeaders(req, auth, body ? body.length : 0);
    const transport = upstream.protocol === "https:" ? https : http;
    const reqMethod = req.method ?? "?";

    return new Promise((resolve) => {
      let connectionTimer: ReturnType<typeof setTimeout> | null = null;

      const proxyReq = transport.request(
        {
          protocol: upstream.protocol,
          hostname: upstream.hostname,
          port: upstream.port || (upstream.protocol === "https:" ? 443 : 80),
          method: reqMethod,
          path: `${upstream.pathname}${upstream.search}`,
          headers: outHeaders,
        },
        (upRes) => {
          if (connectionTimer) {
            clearTimeout(connectionTimer);
            connectionTimer = null;
          }

          const status = upRes.statusCode || 502;

          if (RETRY_STATUS.has(status)) {
            // Capture response body and headers for failure logging
            const capturedHeaders: Record<string, string> = {};
            for (const [k, v] of Object.entries(upRes.headers)) {
              capturedHeaders[k] = Array.isArray(v) ? v[0] : (v ?? "");
            }

            const clientHeaders = flattenHeaders(req.headers);
            readStreamBody(upRes)
              .then((resBody) => {
                logFailure(
                  "retry",
                  reqMethod,
                  upstreamPath,
                  clientHeaders,
                  outHeaders,
                  body,
                  capturedHeaders,
                  resBody,
                  status,
                  `status ${status}`,
                );
                resolve({ ok: false, status, reason: `status ${status}` });
              })
              .catch(() => {
                logFailure(
                  "retry",
                  reqMethod,
                  upstreamPath,
                  clientHeaders,
                  outHeaders,
                  body,
                  capturedHeaders,
                  null,
                  status,
                  `status ${status}`,
                );
                resolve({ ok: false, status, reason: `status ${status}` });
              });
            return;
          }

          if (res.headersSent || res.writableEnded) {
            upRes.resume();
            resolve({ ok: true, committed: true });
            return;
          }

          res.writeHead(status, upRes.headers);

          res.on("error", () => {
            upRes.destroy();
            resolve({ ok: true, committed: true });
          });

          upRes.on("error", () => {
            if (!res.writableEnded) {
              try {
                res.end();
              } catch {}
            }
            resolve({ ok: true, committed: true });
          });

          upRes.pipe(res, { end: true });
          upRes.on("end", () => resolve({ ok: true, committed: true }));
        },
      );

      connectionTimer = setTimeout(() => {
        proxyReq.destroy(new Error("upstream connection timeout"));
      }, config.requestTimeoutMs);
      if (connectionTimer.unref) connectionTimer.unref();

      proxyReq.on("error", (err: Error) => {
        if (connectionTimer) {
          clearTimeout(connectionTimer);
          connectionTimer = null;
        }
        logFailure(
          "error",
          reqMethod,
          upstreamPath,
          flattenHeaders(req.headers),
          outHeaders,
          body,
          null,
          null,
          null,
          err.message,
        );
        resolve({ ok: false, reason: err.message });
      });

      if (body && body.length) proxyReq.write(body);
      proxyReq.end();
    });
  }

  async function forward(
    req: IncomingMessage,
    res: ServerResponse,
    upstreamPath: string,
    body: Buffer | null,
  ): Promise<void> {
    let lastReason = "no attempts";
    for (let attempt = 1; attempt <= config.retryAttempts; attempt++) {
      if (res.writableEnded || res.headersSent) return;
      const result = await attemptOnce(req, res, upstreamPath, body);
      if (result.ok) return;

      lastReason = result.reason || lastReason;
      const more = attempt < config.retryAttempts;
      console.warn(
        `[vsllm-proxy] upstream attempt ${attempt}/${config.retryAttempts} failed (${lastReason})` +
          (more
            ? ` — retrying in ${config.retryIntervalMs}ms`
            : " — giving up"),
      );
      if (more) await sleep(config.retryIntervalMs);
    }

    if (!res.headersSent && !res.writableEnded) {
      respond(res, 502, {
        error: {
          message: `upstream failed after ${config.retryAttempts} attempts: ${lastReason}`,
          type: "upstream_unavailable",
        },
      });
    } else if (!res.writableEnded) {
      try {
        res.end();
      } catch {}
    }
  }

  const handler = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`,
    );
    const pathname = url.pathname.replace(/\/+$/, "") || "/";

    if (pathname === "/" || pathname === "/health" || pathname === "/healthz") {
      respond(res, 200, { status: "ok", upstream: config.upstreamBaseUrl });
      return;
    }

    const routed = route(pathname);
    if (!routed) {
      respond(res, 404, {
        error: {
          message: `not found: ${pathname}`,
          type: "invalid_request_error",
        },
      });
      return;
    }

    try {
      const raw = await readBody(req);
      let body: Buffer = routed.callType
        ? maybeApplyFix(raw, routed.callType)
        : raw;

      if (config.enableRequestLogging) {
        let parsedBody: Record<string, unknown> | null = null;
        try {
          if (body && body.length) {
            parsedBody = JSON.parse(body.toString("utf8")) as Record<
              string,
              unknown
            >;
          }
        } catch {
          parsedBody = null;
        }

        if (parsedBody) {
          const restoreChanged = applyThinkingRestore(
            parsedBody,
            config.thinkingRestore,
          );
          if (restoreChanged) {
            body = Buffer.from(JSON.stringify(parsedBody));
          }

          const props = extractThinkingProps(parsedBody);
          console.log(
            `[vsllm-proxy] ${req.method} ${pathname} ${formatThinkingLog(props)}`,
          );
        } else {
          console.log(
            `[vsllm-proxy] ${req.method} ${pathname} body=non-JSON|empty`,
          );
        }
      }

      await forward(req, res, routed.upstreamPath, body);
    } catch (err: unknown) {
      if (!res.headersSent && !res.writableEnded) {
        respond(res, 500, {
          error: {
            message: String(
              (err && typeof err === "object" && "message" in err
                ? err.message
                : err) || err,
            ),
            type: "proxy_error",
          },
        });
      } else if (!res.writableEnded) {
        try {
          res.end();
        } catch {}
      }
    }
  };

  const server = http.createServer(handler) as ProxyServer;
  server.config = config;
  server.timeout = 0;
  server.keepAliveTimeout = 0;
  return server;
}

export function maybeApplyFix(buf: Buffer, callType: string): Buffer {
  if (!buf || buf.length === 0) return buf;
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(buf.toString("utf8")) as Record<string, unknown>;
  } catch {
    return buf;
  }
  if (!body || typeof body !== "object") return buf;
  body._callType = callType;
  const changed = applyPrefillFix(body);
  if (!changed) return buf;
  delete body._callType;
  return Buffer.from(JSON.stringify(body));
}

export function route(pathname: string): RouteResult | null {
  if (pathname === "/v1/chat/completions") {
    return { upstreamPath: "/v1/chat/completions", callType: "completion" };
  }
  if (pathname === "/v1/responses") {
    return { upstreamPath: "/v1/responses", callType: "responses" };
  }
  if (pathname === "/v1/completions") {
    return { upstreamPath: "/v1/completions", callType: "completion" };
  }
  if (pathname.startsWith("/v1/")) {
    return { upstreamPath: pathname, callType: null };
  }
  return null;
}

export { resolveConfig, resolvePort, loadConfigFile } from "./config.js";
export { modelNeedsFix } from "./prefill-fix.js";
export {
  extractThinkingProps,
  formatThinkingLog,
  applyThinkingRestore,
} from "./thinking-restore.js";
