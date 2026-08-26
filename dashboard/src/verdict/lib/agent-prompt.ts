// ─── agent-prompt — personalized "operate this agent" runbook fetch ───────
//
// The daemon renders a per-agent, operate-only runbook at
// `GET {API_BASE}/v1/agents/:slug/skill.md` (text/markdown). It is the same
// document the RuntimeKeyMintModal and IntegratePage surface — one helper so
// the fetch + key-injection shape is owned in one place.
//
// The template carries three credential sentinels that are filled client-side.

import {
  injectRuntimeCredentials,
  type RuntimeCredentials,
} from "@shared/runtime-credentials";
import { API_BASE } from "../api.js";

export { injectRuntimeCredentials };
export type { RuntimeCredentials };

/**
 * Fetch the raw (still-sentinel'd) runbook markdown for a slug. Throws on a
 * non-2xx response so callers can render an error state. Returns the body
 * text verbatim — call `injectRuntimeCredentials` to fill in the key.
 */
export async function fetchAgentPromptTemplate(slug: string): Promise<string> {
  const res = await fetch(
    `${API_BASE}/v1/agents/${encodeURIComponent(slug)}/skill.md`,
  );
  if (!res.ok) {
    throw new Error(
      `GET /v1/agents/${slug}/skill.md → ${res.status}`,
    );
  }
  return await res.text();
}

/**
 * Fetch + inject in one call — the shape both the mint modal and the
 * integrate page use.
 */
export async function buildAgentPrompt(
  slug: string,
  credentials: RuntimeCredentials = {},
): Promise<string> {
  const template = await fetchAgentPromptTemplate(slug);
  return injectRuntimeCredentials(template, credentials);
}
