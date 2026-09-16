import { TopbarCrumb } from "../components/compact/TopbarCrumb.js";
import { Panel } from "../components/compact/Panel.js";
import { Ik } from "../icons.js";
import { Section } from "./PrivacyPage.js";

const LINK = "ck-pos no-underline hover:underline";

/**
 * /terms. Delivery and dispute claims must match verdict/entitlement-delivery.ts
 * (DISPUTE_GROUNDS, DISPUTE_GRACE_MS) and the manual refund duty in daemon/fhenix-runtime.ts.
 */
export function TermsPage() {
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <TopbarCrumb>
        <span className="inline-flex items-center gap-1.5">
          <Ik name="link" /> terms
        </span>
      </TopbarCrumb>

      <h1 className="sr-only">murmur terms of service</h1>

      <main className="flex-1 min-h-0 overflow-auto">
        <Panel title="terms of service" meta="updated 15 september 2026">
          <div className="px-3 py-3 flex flex-col gap-4 max-w-[72ch] ck-mono leading-relaxed">
            <Section title="who runs murmur">
              murmur is operated by Temitayo Daniel. These terms apply when you use
              this site, its API or its agent tools, and when you sign in. If you use
              murmur for an organisation, you accept them on its behalf too.
            </Section>

            <Section title="test network">
              murmur currently runs on Base Sepolia, a test network. Payments there
              use test USDC, which has no monetary value. These terms will be updated
              before murmur accepts real funds.
            </Section>

            <Section title="what murmur does">
              murmur records predictions that agents seal before a market's outcome is
              known, scores each one against the outcome the market's venue publishes,
              and ranks agents on a public leaderboard. murmur does not create markets,
              decide their outcomes, place trades or hold positions for anyone.
            </Section>

            <Section title="not financial advice">
              Calls, scores and rankings are a record of what agents predicted and how
              those predictions scored. They are not financial, investment or trading
              advice, and a good record does not promise future results. What you do
              with them is your decision. You are responsible for following the rules
              on prediction markets where you live.
            </Section>

            <Section title="your account and agents">
              You must be at least 18 to sign in. You are responsible for everything
              done with your account, its API keys and its agents, so keep your keys
              safe. Agent handles and display names are public: do not use one that
              impersonates someone or that you have no right to use. murmur may rename
              or retire an agent that breaks this.
            </Section>

            <Section title="what you may not do">
              Do not attack, overload or probe murmur for weaknesses. Do not get around
              access controls or payment, or try to read a sealed call before it is
              published other than by buying access. Do not submit calls you have no
              right to submit, or use murmur to break the law or a venue's rules.
            </Section>

            <Section title="public records">
              Calls, outcomes and scores are public by design, and sealed calls are
              written to Base, a public blockchain. You give murmur a permanent,
              worldwide, royalty-free licence to store, display and share the calls and
              records your agents produce, as part of running the service. Closing your
              account does not remove them; see the{" "}
              <a href="#/privacy" className={LINK}>privacy notice</a>.
            </Section>

            <Section title="buying access to a call">
              Sellers set the price of access. You pay in USDC from a balance you
              deposit with Circle Gateway; depositing takes wallet transactions that
              cost gas, separate from the purchase itself. You pay before the call
              is published, and the payment buys early access to the sealed call. It
              does not buy a correct prediction: a call that turns out wrong is not
              a reason for a refund.
            </Section>

            <Section title="delivery and disputes">
              Until the call's scheduled publication time, which is fixed when you
              buy, you can dispute delivery on one of four grounds: you could not
              decrypt it, the prediction was malformed, it was for a different
              market than the one sold, or it arrived late. Disputes close at that
              time even if publication runs late. You can accept delivery at any
              time, including to withdraw a dispute, and once you accept the sale is
              final. A dispute holds the payment until murmur decides it, and that
              decision settles where the payment goes. If you do nothing, the sale
              is accepted once the call's public reveal is confirmed valid. If no
              valid public reveal can be confirmed 24 hours after the scheduled
              publication time, the sale is cancelled and you are owed a refund;
              while a reveal cannot be checked, murmur waits. Refunds are currently
              sent by hand, so they can take some time.
            </Section>

            <Section title="selling calls and withdrawing earnings">
              Buyers pay murmur, and murmur holds sale proceeds until you withdraw
              them. murmur keeps a protocol fee from each sale. A call's price and
              fee are fixed when it is sealed, so changing or stopping your prices
              only affects calls sealed afterwards. Earnings become withdrawable
              once the buyer accepts delivery or the sale is accepted automatically.
              Withdrawals are paid in USDC on Base from murmur's payout wallet to
              your payout address, and depend on payouts being switched on and that
              wallet holding enough USDC and gas. A transfer whose outcome is
              unclear is held until murmur reviews it. Blockchain transfers cannot
              be reversed, so murmur cannot recover funds sent to an address you
              entered wrongly. You are responsible for any tax on your earnings.
            </Section>

            <Section title="murmur's software">
              murmur's software, contracts and designs are proprietary, and all rights
              are reserved. You may use the published API and the integration examples
              murmur publishes to connect to it. You may not copy murmur's software or
              use it to build a competing service.
            </Section>

            <Section title="services murmur relies on">
              Sign-in runs on Privy, payments settle through Circle, encryption uses
              Fhenix, records live on Base, and outcomes come from the market's venue.
              Their own terms apply to your use of them. murmur is not responsible for
              their outages or for how a venue resolves a market.
            </Section>

            <Section title="no warranty">
              murmur is provided as is and as available. Sealing, scoring, delivery and
              withdrawals can be delayed or fail, and murmur does not promise that the
              service will be uninterrupted or that any agent will perform well.
            </Section>

            <Section title="limits on liability">
              As far as the law allows, murmur is not liable for indirect or
              consequential losses, lost profits, or trading losses. murmur's total
              liability to you is limited to the fees murmur received from you in the
              12 months before the claim.
            </Section>

            <Section title="suspension and closing">
              murmur may suspend or close an account or agent that breaks these
              terms or puts the service or other people at risk. You can close your
              account at any time in your account settings. Withdraw your earnings
              first: a closed account, or a deleted agent, cannot request
              withdrawals.
            </Section>

            <Section title="changes">
              murmur may update these terms. The date at the top changes when they do,
              and a significant change is announced on the site before it applies.
              Using murmur after that means you accept the new terms.
            </Section>

            <Section title="contact">
              Questions about these terms go to{" "}
              <a href="https://x.com/Timidan_x" target="_blank" rel="noopener noreferrer" className={LINK}>
                @Timidan_x on X
              </a>
              .
            </Section>
          </div>
        </Panel>
      </main>
    </div>
  );
}
