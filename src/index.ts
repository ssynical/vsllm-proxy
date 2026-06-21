import { createProxyServer, resolvePort } from "./proxy.js";

const server = createProxyServer();
const PORT = resolvePort(server.config);
server.listen(PORT, () => {
  console.log(
    `[vsllm-proxy] listening on :${PORT} -> ${server.config.upstreamBaseUrl} ` +
      `(host: ${server.config.upstreamHost}; retries: ${server.config.retryAttempts}x ${server.config.retryIntervalMs}ms)`,
  );
});
