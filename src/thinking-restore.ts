import type { ThinkingProps } from "./types.js";

const THINKING_KEYS = ["thinking", "thinking_budget", "reasoning_effort", "reasoning"] as const;

export function extractThinkingProps(body: Record<string, unknown> | null | undefined): ThinkingProps {
  if (!body || typeof body !== "object") return {};
  const props: ThinkingProps = {};

  if (body.model) props.model = String(body.model);

  for (const key of THINKING_KEYS) {
    if (key in body) props[key] = body[key];
  }

  return props;
}

export function formatThinkingLog(props: ThinkingProps): string {
  const entries = Object.entries(props);
  if (!entries.length) return "no body / no thinking props";
  return entries
    .map(([k, v]) => {
      const val = typeof v === "object" ? JSON.stringify(v) : String(v);
      return `${k}=${val}`;
    })
    .join(" ");
}

export function applyThinkingRestore(
  body: Record<string, unknown> | null | undefined,
  enabled: boolean
): boolean {
  if (!enabled) return false;
  if (!body || typeof body !== "object") return false;
  return false;
}

export const THINKING_KEYS_EXPORT = THINKING_KEYS;
