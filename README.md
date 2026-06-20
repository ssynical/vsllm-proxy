# vsllm-proxy

A minimal, zero-dependency OpenAI-compatible forwarding proxy in Node.js, with the Claude 4.6+ prefill auto-fix baked in.

It exposes the standard endpoints:

- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/completions`
- `GET  /v1/models` (and any other `/v1/*` path — forwarded verbatim)
- `GET  /health`

… and forwards each request to an upstream OpenAI-compatible endpoint (`config.json` → `upstreamBaseUrl`) using the caller's `Authorization` header (falling back to `upstreamApiKey`).

Failed upstream requests are retried automatically (see [Retries](#retries)).

## The Claude 4.6+ prefill fix

Starting with Claude 4.6, Anthropic removed assistant-message **prefill** support — a request whose last message has `role: "assistant"` is rejected. This proxy detects that case and, when the target model is Claude 4.6+, appends a trailing `user` message. If the assistant message contains `tool_use` blocks, the appended user message carries matching `tool_result` blocks (required by Anthropic API validation).

This is a faithful Node port of the LiteLLM `AppendContinueCallback`. The model match regex covers `claude-{sonnet,opus,haiku}-4-6` and up, plus `claude-mythos`:

```
claude-(?:sonnet|opus|haiku)-4-([6-9]|\d{2,})
| claude-(?:sonnet|opus|haiku)-([5-9]|\d{2,})-
| claude-mythos
```

Older models (e.g. `claude-sonnet-4-5`) are left untouched.

The fix is applied only to endpoints that carry a `messages` array (`/v1/chat/completions`, `/v1/responses`, `/v1/completions`). `/v1/models` and other paths forward verbatim.

## Configure

Configuration lives in **`config.json`** (next to the project root, or at the path in `CONFIG_PATH`):

```json
{
  "port": 8888,
  "upstreamBaseUrl": "https://api.openai.com",
  "upstreamApiKey": "",
  "upstreamHost": "",
  "requestTimeoutMs": 600000,
  "retryAttempts": 10,
  "retryIntervalMs": 3000
}
```

| Key                 | Default              | Description                                                     |
| ------------------- | -------------------- | --------------------------------------------------------------- |
| `port`              | `8888`               | Local listen port (overridable by the `PORT` env var)           |
| `upstreamBaseUrl`   | `https://api.openai.com` | Upstream OpenAI-compatible base URL                        |
| `upstreamApiKey`    | _none_               | Fallback key when a caller omits `Authorization`                |
| `upstreamHost`      | host from base URL   | `Host` header sent upstream (useful behind a gateway)           |
| `requestTimeoutMs`  | `600000`             | Per-upstream-attempt timeout                                    |
| `retryAttempts`     | `10`                 | Max attempts per request (see [Retries](#retries))              |
| `retryIntervalMs`   | `3000`               | Pause between attempts                                          |

## Run

```bash
npm start
# or
node lib/proxy.js
```

Point a client at the proxy instead of the upstream:

```bash
curl http://127.0.0.1:8888/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H "content-type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [
      {"role": "user", "content": "start a sentence"},
      {"role": "assistant", "content": "Once upon a"}
    ]
  }'
```

The proxy will append a trailing `{"role":"user","content":"continue"}` before forwarding. Non-streaming and streaming (`text/event-stream`) responses are piped straight back.

## Retries

Each request is sent to the upstream up to **`retryAttempts`** times (default 10), pausing **`retryIntervalMs`** (default 3000 ms) between attempts. A request is retried when an attempt:

- fails to connect, the socket drops, or the request times out, or
- returns one of `408, 409, 425, 429, 500, 502, 503, 504`.

Other statuses (e.g. `200`, `400`, `404`) are returned to the client immediately — only transient/server errors are retried. The response is committed to the client only on the first successful attempt, so failed attempts never leak partial/streamed data. If every attempt fails, the client receives a `502 upstream_unavailable`.

Point a client at the proxy instead of the upstream:

```bash
curl http://127.0.0.1:8888/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H "content-type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [
      {"role": "user", "content": "start a sentence"},
      {"role": "assistant", "content": "Once upon a"}
    ]
  }'
```

The proxy will append a trailing `{"role":"user","content":"continue"}` before forwarding. Non-streaming and streaming (`text/event-stream`) responses are piped straight back.

## Tests

```bash
npm test
```

Unit tests cover the prefill logic; end-to-end tests boot a mock upstream and a real proxy server to assert the body is mutated before forwarding, that `/v1/models` passes through unchanged, and that retry behavior works (retryable-status recovery, connection-drop recovery, give-up-after-N, and non-retryable-status pass-through).
