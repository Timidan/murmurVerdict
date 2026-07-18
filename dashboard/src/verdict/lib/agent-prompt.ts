// ─── agent-prompt — personalized "operate this agent" runbook fetch ───────
//
// The daemon renders a per-agent, operate-only runbook at
// `GET {API_BASE}/v1/agents/:slug/skill.md` (text/markdown). It is the same
// document the RuntimeKeyMintModal and IntegratePage surface — one helper so
// the fetch + key-injection shape is owned in one place.
//
// The template carries the literal sentinel `__MURMUR_RUNTIME_KEY__` at the
// spot where the agent's runtime key belongs. We swap it client-side with the
// one-time plaintext secret when we have it (post-mint handoff), or with an
// honest placeholder line that points the operator at the mint flow otherwise.

import { API_BASE } from "../api.js";

/** Sentinel the daemon writes where the runtime key belongs. */
const RUNTIME_KEY_SENTINEL = "__MURMUR_RUNTIME_KEY__";

/** Shown in place of the key when we don't hold the one-time secret. */
const RUNTIME_KEY_PLACEHOLDER =
  "<your mrt_… runtime key — mint one under Account → runtime keys>";

/**
 * Fetch the raw (still-sentinel'd) runbook markdown for a slug. Throws on a
 * non-2xx response so callers can render an error state. Returns the body
 * text verbatim — call `injectRuntimeKey` to fill in the key.
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
 * Replace every occurrence of the runtime-key sentinel with the plaintext
 * key when provided, otherwise a placeholder that routes the operator to the
 * mint flow. Kept pure so both the modal and IntegratePage share the logic.
 */
export function injectRuntimeKey(template: string, runtimeKey?: string): string {
  return template.replaceAll(
    RUNTIME_KEY_SENTINEL,
    runtimeKey && runtimeKey.length > 0 ? runtimeKey : RUNTIME_KEY_PLACEHOLDER,
  );
}

/**
 * Fetch + inject in one call — the shape both the mint modal and the
 * integrate page use.
 */
export async function buildAgentPrompt(
  slug: string,
  runtimeKey?: string,
): Promise<string> {
  const template = await fetchAgentPromptTemplate(slug);
  return injectRuntimeKey(template, runtimeKey);
}
