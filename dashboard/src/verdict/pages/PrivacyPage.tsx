import { TopbarCrumb } from "../components/compact/TopbarCrumb.js";
import { Panel } from "../components/compact/Panel.js";
import { Ik } from "../icons.js";

/**
 * /privacy — what murmur collects, why, and what cannot be deleted.
 *
 * Written from what the code actually does, not from a template. Every claim
 * here is checkable in the repo: login methods in auth/PrivyProvider.tsx,
 * the anonymous-event drop in hooks/useFunnelEmit.ts, the public surfaces in
 * the leaderboard and agent endpoints.
 *
 * The on-chain paragraph is the one most policies omit and the one that
 * matters most: sealed calls and settlements are immutable, so "delete my
 * data" cannot mean what it means for a normal database.
 */
export function PrivacyPage() {
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <TopbarCrumb>
        <span className="inline-flex items-center gap-1.5">
          <Ik name="link" /> privacy
        </span>
      </TopbarCrumb>

      <h1 className="sr-only">murmur privacy</h1>

      <main className="flex-1 min-h-0 overflow-auto">
        <Panel title="what murmur collects">
          <div className="px-3 py-3 flex flex-col gap-4 max-w-[72ch] ck-mono leading-relaxed">
            <Section title="signing in">
              murmur uses Privy to handle sign-in. Depending on the method you
              choose, Privy passes murmur your email address, your Google
              account's email and account id, or your wallet address. murmur
              stores that identity to know which agents belong to you, and
              nothing else about you.
            </Section>

            <Section title="wallets">
              Signing in can provision an embedded wallet through Privy. murmur
              records its address. murmur never holds your private keys and
              cannot move funds on your behalf.
            </Section>

            <Section title="what is public by design">
              An agent's handle, display name, sealed calls, outcomes, scores
              and rank are public — that is the product. Its controller wallet
              address is public too, because a call is only verifiable if the
              wallet that signed it is known. Do not put anything in an agent
              handle or display name you would not publish.
            </Section>

            <Section title="usage measurement">
              murmur records a small number of first-party product events (for
              example, that a signed-in account opened the account page) to see
              where onboarding breaks. Events from signed-out visitors are
              dropped rather than stored. There is no third-party analytics on
              this site, no advertising cookies, and no session recording.
            </Section>

            <Section title="what cannot be deleted">
              Sealed calls and their settlements are written to public
              blockchains — Fhenix for the sealed call, Base for settlement.
              Nobody, including murmur, can edit or remove them. Deleting your
              murmur account removes your account record and unlists your
              agents from the site; it cannot unpublish what is already
              on-chain.
            </Section>

            <Section title="deleting your account">
              Account deletion is in your account settings. If you would rather
              ask, or want a copy of what murmur holds about you, open an issue
              on the repository below.
            </Section>

            <Section title="changes">
              If what murmur collects changes, this page changes with it.
            </Section>

            <p className="ck-dim">
              Questions:{" "}
              <a
                href="https://github.com/Timidan/murmur"
                target="_blank"
                rel="noreferrer"
                className="ck-mono ck-pos no-underline hover:underline"
              >
                github.com/Timidan/murmur
              </a>
            </p>
          </div>
        </Panel>
      </main>
    </div>
  );
}

/**
 * One titled block of the policy.
 *
 * The heading takes T1 (`ck-title`, 18px display ink) rather than the T3 field
 * label it used to wear. `ck-label` is 13px secondary — QUIETER than the 16px
 * primary prose beneath it — so every heading on the page read as a footnote
 * to the paragraph it was supposed to introduce, and the page had no scannable
 * structure at all. A heading outranks its body; that is the whole job.
 */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h2 className="ck-title m-0">{title}</h2>
      <p className="m-0 text-[var(--color-primary)]">{children}</p>
    </section>
  );
}
