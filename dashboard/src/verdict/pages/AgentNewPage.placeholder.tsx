import { CompactTopbar } from "../components/compact/Topbar.js";

/**
 * Phase 7a placeholder. The AgentNewPage from RESEARCH_casual_tier_onboarding_ux.md
 * §2.c lands in Phase 7b alongside ApiKeyMintModal. Until then this stub
 * gives the `[ + NEW AGENT ]` CTA on AccountPage somewhere to land — fixes
 * the codex P2 from the Phase 7a review ("CTA falls through to landing").
 */
export function AgentNewPagePlaceholder() {
  return (
    <div className="compact-shell min-h-dvh flex flex-col">
      <CompactTopbar
        crumb={
          <span>
            <a href="#/account" className="ck-dim hover:ck-pos no-underline">
              ACCOUNT
            </a>
            <span className="ck-dim mx-1">/</span>
            <span className="ck-pos">NEW AGENT</span>
          </span>
        }
      />
      <main className="flex-1 grid place-items-start px-3 py-6">
        <div className="flex flex-col items-start gap-3 max-w-[52ch]">
          <p className="ck-mono ck-dim">phase 7b — agent creation lands next release.</p>
          <p className="ck-mono ck-dim text-[10px]">
            this surface will host slug picker, display-name + bio inputs, kind=casual
            commit, and the one-time api-key reveal modal. shipping in the next pull.
          </p>
          <a href="#/account" className="ck-btn">
            ← BACK TO ACCOUNT
          </a>
        </div>
      </main>
    </div>
  );
}
