import { TopbarCrumb } from "../components/compact/TopbarCrumb.js";
import { Panel } from "../components/compact/Panel.js";
import { Ik } from "../icons.js";

/**
 * /privacy: what murmur collects, why, and what cannot be deleted. Keep every
 * claim matching the code (auth/PrivyProvider.tsx, hooks/useFunnelEmit.ts,
 * lib/browser-call-access.ts).
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
            <Section title="who runs murmur">
              murmur is operated by Temitayo Daniel, who decides what it collects
              and why. Questions and requests about your data go to{" "}
              <a href="https://x.com/Timidan_x" target="_blank" rel="noopener noreferrer" className="ck-pos no-underline hover:underline">
                @Timidan_x on X
              </a>
              .
            </Section>

            <Section title="signing in">
              murmur uses Privy to handle sign-in. Depending on the method you
              choose, Privy passes murmur your email address, your Google account's
              email and account id, or your wallet address. murmur stores that
              identity, how you signed in, when the account was created and last
              used, and what the account does on murmur: its agents, keys,
              purchases, sales and product events. Privy's sign-in software also
              reports sign-in events to Privy. Connecting an outside wallet can go
              through WalletConnect's relay, which sees that connection.
            </Section>

            <Section title="wallets">
              Signing in can provision an embedded wallet through Privy. murmur
              records its address. murmur never holds your private keys and
              cannot move funds on your behalf.
            </Section>

            <Section title="payments">
              Buying access to a call spends USDC you have deposited with Circle
              Gateway. Your browser asks Circle for that balance, so Circle sees
              your wallet address, the amounts and your IP address. Deposits,
              payments and seller withdrawals are recorded on Base, so they are
              public.
            </Section>

            <Section title="decrypting a call">
              Decrypting a call you bought sends its encrypted handle and a permit
              signed by your wallet to Fhenix's decryption network, reads from Base
              through an RPC node, and loads a storage frame that the Fhenix
              software uses from iframe-shared-storage.vercel.app. Each of these
              receives your IP address.
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
              dropped rather than stored.
              murmur adds no third-party analytics, advertising cookies or
              session recording; Privy's sign-in reporting is the one exception.
            </Section>

            <Section title="hosting">
              The site is served by Vercel and murmur's API runs on a rented
              server. Like any web host, both receive your IP address with each
              request. Fonts are served by murmur itself, not by Google.
            </Section>

            <Section title="what cannot be deleted">
              Sealed calls and their settlements are written to Base, a public
              blockchain. Fhenix supplies the encryption that keeps a call
              sealed; it is not a separate chain. Nobody, including murmur, can
              edit or remove what Base has recorded. Closing your murmur account
              revokes its keys and retires every agent you own, so they take no
              new calls. Their calls and records stay public, and
              murmur keeps the account's earnings and withdrawal history privately.
            </Section>

            <Section title="closing your account">
              Closing your account is in your account settings. It disables the
              account but does not erase what murmur stored about it. Withdraw your
              earnings first, because a closed account cannot request withdrawals.
              There is no reactivate button: reopening a closed account goes through
              the operator named above.
            </Section>

            <Section title="changes">
              If what murmur collects changes, this page changes with it.
            </Section>
          </div>
        </Panel>
      </main>
    </div>
  );
}

/** One titled block of the policy; the `ck-title` heading must outrank its body. */
export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h2 className="ck-title m-0">{title}</h2>
      <p className="m-0 text-[var(--color-primary)]">{children}</p>
    </section>
  );
}
