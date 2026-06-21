import test from "node:test";
import assert from "node:assert";
import http from "node:http";
import {
  createProxyServer,
  route,
  maybeApplyFix,
  resolveConfig,
} from "../src/proxy.js";
import {
  extractThinkingProps,
  formatThinkingLog,
  applyThinkingRestore,
} from "../src/thinking-restore.js";
import type { ProxyServer } from "../src/types.js";

test("route maps the three primary endpoints", () => {
  assert.deepEqual(route("/v1/chat/completions"), {
    upstreamPath: "/v1/chat/completions",
    callType: "completion",
  });
  assert.deepEqual(route("/v1/responses"), {
    upstreamPath: "/v1/responses",
    callType: "responses",
  });
  assert.deepEqual(route("/v1/completions"), {
    upstreamPath: "/v1/completions",
    callType: "completion",
  });
});

test("route forwards /v1/models verbatim (no prefill fix)", () => {
  assert.deepEqual(route("/v1/models"), {
    upstreamPath: "/v1/models",
    callType: null,
  });
});

test("route passes through arbitrary /v1 paths", () => {
  assert.deepEqual(route("/v1/embeddings"), {
    upstreamPath: "/v1/embeddings",
    callType: null,
  });
});

test("route returns null for unknown roots", () => {
  assert.equal(route("/foo"), null);
  assert.equal(route("/"), null);
});

test("maybeApplyFix passes through non-JSON bodies", () => {
  const buf = Buffer.from("not json");
  assert.equal(maybeApplyFix(buf, "completion"), buf);
});

test("maybeApplyFix strips the internal _callType field", () => {
  const out = maybeApplyFix(
    Buffer.from(
      JSON.stringify({
        model: "claude-sonnet-4-6",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hi back" },
        ],
      }),
    ),
    "completion",
  );
  assert.equal(JSON.parse(out.toString())._callType, undefined);
});

async function boot(
  {
    upstreamHandler,
  }: {
    upstreamHandler: (
      req: http.IncomingMessage,
      res: http.ServerResponse,
    ) => void;
  },
  proxyOpts: Record<string, unknown> = {},
): Promise<{ proxy: ProxyServer; upstream: http.Server }> {
  const upstream = http.createServer(upstreamHandler);
  await new Promise<void>((r) => upstream.listen(0, r));
  const upstreamPort = (upstream.address() as { port: number }).port;
  const proxy = createProxyServer({
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
    upstreamApiKey: "test-key",
    retryAttempts: 10,
    retryIntervalMs: 10,
    ...proxyOpts,
  } as any);
  await new Promise<void>((r) => proxy.listen(0, r));
  return { proxy, upstream };
}

function close(srv: http.Server | ProxyServer): Promise<void> {
  return new Promise((r) => srv.close(() => r()));
}

function proxyRequest(
  port: number,
  {
    path,
    method = "POST",
    headers = {},
    body,
  }: {
    path: string;
    method?: string;
    headers?: Record<string, string>;
    body?: any;
  },
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: { "content-type": "application/json", ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

test("e2e: prefill fix is applied before forwarding to upstream", async () => {
  let captured: any;
  const { proxy, upstream } = await boot({
    upstreamHandler: async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const parsed = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      captured = parsed;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    },
  });

  try {
    const port = (proxy.address() as { port: number }).port;
    await proxyRequest(port, {
      path: "/v1/chat/completions",
      body: {
        model: "claude-sonnet-4-6",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hi back" },
        ],
      },
    });

    assert.equal(captured.messages.length, 3);
    assert.deepEqual(captured.messages[2], {
      role: "user",
      content: "continue",
    });
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: non-Claude-4.6+ requests forward unchanged", async () => {
  let captured: any;
  const { proxy, upstream } = await boot({
    upstreamHandler: async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      captured = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    },
  });

  try {
    const port = (proxy.address() as { port: number }).port;
    await proxyRequest(port, {
      path: "/v1/responses",
      body: {
        model: "claude-sonnet-4-5",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hi back" },
        ],
      },
    });
    assert.equal(captured.messages.length, 2);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: /v1/models forwards verbatim with no body mutation", async () => {
  let hitPath: string | undefined;
  const { proxy, upstream } = await boot({
    upstreamHandler: async (req, res) => {
      hitPath = req.url;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "gpt-4o" }] }));
    },
  });

  try {
    const port = (proxy.address() as { port: number }).port;
    const out = await proxyRequest(port, {
      path: "/v1/models",
      method: "GET",
    });
    assert.equal(hitPath, "/v1/models");
    assert.equal(out.status, 200);
    assert.deepEqual(JSON.parse(out.body), { data: [{ id: "gpt-4o" }] });
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: upstream API key is injected when caller omits Authorization", async () => {
  let authHeader: string | undefined;
  const { proxy, upstream } = await boot({
    upstreamHandler: async (req, res) => {
      authHeader = req.headers["authorization"];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    },
  });

  try {
    const port = (proxy.address() as { port: number }).port;
    await proxyRequest(port, {
      path: "/v1/chat/completions",
      body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(authHeader, "Bearer test-key");
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: caller Authorization is forwarded and preferred over the configured key", async () => {
  let authHeader: string | undefined;
  const { proxy, upstream } = await boot({
    upstreamHandler: async (req, res) => {
      authHeader = req.headers["authorization"];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    },
  });

  try {
    const port = (proxy.address() as { port: number }).port;
    await proxyRequest(port, {
      path: "/v1/chat/completions",
      headers: { authorization: "Bearer caller-key" },
      body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(authHeader, "Bearer caller-key");
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: retries a retryable status then succeeds", async () => {
  let hits = 0;
  const { proxy, upstream } = await boot({
    upstreamHandler: (req, res) => {
      hits++;
      if (hits < 3) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "temp" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, hits }));
    },
  });

  try {
    const port = (proxy.address() as { port: number }).port;
    const out = await proxyRequest(port, {
      path: "/v1/chat/completions",
      body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(out.status, 200);
    assert.equal(hits, 3);
    assert.deepEqual(JSON.parse(out.body), { ok: true, hits: 3 });
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: retries a connection refusal then succeeds when upstream comes up", async () => {
  let hits = 0;
  const { proxy, upstream } = await boot({
    upstreamHandler: (req, res) => {
      hits++;
      if (hits === 1) {
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    },
  });

  try {
    const port = (proxy.address() as { port: number }).port;
    const out = await proxyRequest(port, {
      path: "/v1/chat/completions",
      body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(out.status, 200);
    assert.ok(hits >= 2, `expected at least 2 upstream hits, got ${hits}`);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: gives up after retryAttempts and returns 502", async () => {
  let hits = 0;
  const { proxy, upstream } = await boot(
    {
      upstreamHandler: (req, res) => {
        hits++;
        res.writeHead(429, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "rate limited" }));
      },
    },
    { retryAttempts: 3, retryIntervalMs: 5 },
  );

  try {
    const port = (proxy.address() as { port: number }).port;
    const out = await proxyRequest(port, {
      path: "/v1/chat/completions",
      body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(out.status, 502);
    assert.equal(hits, 3);
    const parsed = JSON.parse(out.body);
    assert.equal(parsed.error.type, "upstream_unavailable");
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: non-retryable status (400) is returned immediately, not retried", async () => {
  let hits = 0;
  const { proxy, upstream } = await boot({
    upstreamHandler: (req, res) => {
      hits++;
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "bad request" } }));
    },
  });

  try {
    const port = (proxy.address() as { port: number }).port;
    const out = await proxyRequest(port, {
      path: "/v1/chat/completions",
      body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(out.status, 400);
    assert.equal(hits, 1, "400 must not be retried");
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test("resolveConfig reads config.json values", () => {
  const cfg = resolveConfig();
  assert.equal(cfg.retryAttempts, 10);
  assert.equal(cfg.retryIntervalMs, 3000);
  assert.ok(cfg.upstreamBaseUrl.length > 0);
});

test("resolveConfig opts override config.json", () => {
  const cfg = resolveConfig({ retryAttempts: 2, retryIntervalMs: 50 });
  assert.equal(cfg.retryAttempts, 2);
  assert.equal(cfg.retryIntervalMs, 50);
});

test("extractThinkingProps captures model and known thinking keys", () => {
  const props = extractThinkingProps({
    model: "claude-sonnet-4-6",
    messages: [],
    thinking_budget: 16000,
    reasoning_effort: "high",
  });
  assert.deepEqual(props, {
    model: "claude-sonnet-4-6",
    thinking_budget: 16000,
    reasoning_effort: "high",
  });
});

test("extractThinkingProps returns empty for null/empty bodies", () => {
  assert.deepEqual(extractThinkingProps(null), {});
  assert.deepEqual(extractThinkingProps({}), {});
  assert.deepEqual(extractThinkingProps(undefined), {});
});

test("formatThinkingLog serializes props into key=value pairs", () => {
  const line = formatThinkingLog({
    model: "gpt-4o",
    thinking: true,
  });
  assert.ok(line.includes("model=gpt-4o"));
  assert.ok(line.includes("thinking=true"));
});

test("formatThinkingLog serializes objects as JSON", () => {
  const line = formatThinkingLog({
    model: "x",
    thinking: { type: "enabled", budget_tokens: 2000 },
  });
  assert.ok(line.includes('thinking={"type":"enabled","budget_tokens":2000}'));
});

test("applyThinkingRestore is a no-op by default", () => {
  const body = { model: "gpt-4o" };
  assert.equal(applyThinkingRestore(body, false), false);
  assert.deepEqual(body, { model: "gpt-4o" });
});

test("applyThinkingRestore is a no-op even when enabled (placeholder)", () => {
  const body = { model: "gpt-4o" };
  assert.equal(applyThinkingRestore(body, true), false);
  assert.deepEqual(body, { model: "gpt-4o" });
});

test("e2e: logs model and thinking properties to stdout", async () => {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: any[]) => logs.push(args.join(" "));

  let captured: any;
  const { proxy, upstream } = await boot({
    upstreamHandler: async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      captured = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    },
  });

  try {
    const port = (proxy.address() as { port: number }).port;
    await proxyRequest(port, {
      path: "/v1/chat/completions",
      body: {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
        thinking_budget: 16000,
      },
    });

    assert.equal(captured.model, "claude-sonnet-4-6");
    const logLine = logs.find((l) =>
      l.includes("[vsllm-proxy] POST /v1/chat/completions"),
    );
    assert.ok(logLine, `expected log line, got: ${logs.join("\n")}`);
    assert.ok(logLine.includes("model=claude-sonnet-4-6"), logLine);
    assert.ok(logLine.includes("thinking_budget=16000"), logLine);
  } finally {
    console.log = origLog;
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: logs non-JSON body correctly", async () => {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: any[]) => logs.push(args.join(" "));

  const { proxy, upstream } = await boot({
    upstreamHandler: (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    },
  });

  try {
    const port = (proxy.address() as { port: number }).port;
    await proxyRequest(port, {
      path: "/v1/chat/completions",
      body: "not json",
    });

    const logLine = logs.find((l) =>
      l.includes("[vsllm-proxy] POST /v1/chat/completions"),
    );
    assert.ok(logLine, `expected log line, got: ${logs.join("\n")}`);
    assert.ok(logLine.includes("body=non-JSON|empty"), logLine);
  } finally {
    console.log = origLog;
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: logging disabled when enableRequestLogging is false", async () => {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: any[]) => logs.push(args.join(" "));

  const { proxy, upstream } = await boot(
    {
      upstreamHandler: (req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      },
    },
    { enableRequestLogging: false },
  );

  try {
    const port = (proxy.address() as { port: number }).port;
    await proxyRequest(port, {
      path: "/v1/chat/completions",
      body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    });

    const logLine = logs.find((l) =>
      l.includes("[vsllm-proxy] POST /v1/chat/completions"),
    );
    assert.equal(logLine, undefined, "logging should be silent when disabled");
  } finally {
    console.log = origLog;
    await close(proxy);
    await close(upstream);
  }
});
