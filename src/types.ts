import type { IncomingMessage, ServerResponse, Server } from "node:http";

export interface ProxyConfig {
  port: number | null;
  upstreamBaseUrl: string;
  upstreamApiKey: string;
  upstreamHost: string;
  requestTimeoutMs: number;
  retryAttempts: number;
  retryIntervalMs: number;
  enableRequestLogging: boolean;
  thinkingRestore: boolean;
}

export interface RouteResult {
  upstreamPath: string;
  callType: "completion" | "responses" | null;
}

export interface AttemptResult {
  ok: boolean;
  committed?: boolean;
  status?: number;
  reason?: string;
}

export interface UpstreamErrorResponse {
  error: {
    message: string;
    type: string;
  };
}

export interface ThinkingProps {
  model?: string;
  thinking?: unknown;
  thinking_budget?: unknown;
  reasoning_effort?: unknown;
  reasoning?: unknown;
  [key: string]: unknown;
}

export interface PrefillBody {
  model?: string;
  messages?: Array<{ role: string; content: unknown; [key: string]: unknown }>;
  metadata?: { trace_id?: string };
  litellm_trace_id?: string;
  _callType?: string;
  [key: string]: unknown;
}

export interface ProxyServer extends Server {
  config: ProxyConfig;
}

export interface CreateProxyOpts extends Partial<ProxyConfig> {
  _skipFile?: boolean;
}
