// ─── The terms one sealed call is sold under ────────────────────────────────
//
// PURE. No database, no environment, no clock — a snapshot in, terms or null
// out. It exists as its own module because two call sites must answer the
// question identically:
//
//   · entitlement-access-surface.termsFor()  — what a buyer is charged.
//   · gateway-sellable-surface               — what the storefront advertises.
//
// A storefront that priced calls with its own copy of these rules would drift
// from the payment path, and the drift is the worst kind: it shows a price the
// checkout does not honour, or lists a call the checkout refuses to sell.

export interface CallTerms {
  priceAtoms: string;
  currency: string;
  pricingVersion: string;
}

/**
 * The provider-terms columns this resolver reads. Structurally satisfied by
 * FhenixSealedCallRow, and narrow enough that a listing query can select just
 * these four columns instead of the whole row.
 */
export interface CallTermsSnapshot {
  provider_price_atoms?: string | null;
  provider_currency?: string | null;
  provider_pricing_version?: string | null;
  /**
   * 1 when the row was written by a build that snapshots provider terms. 0 (or
   * absent) only on rows predating migration 070.
   */
  provider_terms_snapshotted?: number | null;
}

/**
 * The terms THIS call is sold under, or null when it is not for sale.
 *
 * From the call's own snapshot when it has one — the provider's price as it
 * stood when the call was sealed. An owner repricing afterwards must not
 * change what a buyer is charged for a call already on offer, and must not
 * make a purchase in flight disagree with the challenge it answered.
 *
 * A missing snapshot means one of two opposite things, and
 * `provider_terms_snapshotted` is what separates them:
 *
 *   flag 0 — sealed before providers could price themselves. It really was
 *            sold under the deployment-wide terms, so fall back to them.
 *   flag 1 — the owner set no terms, or cleared them. NOT FOR SALE. Falling
 *            back here would sell an owner's signal at the operator's price
 *            straight after they pressed "stop selling".
 *
 * `legacyTerms` is the deployment-wide fallback, and it is nullable on
 * purpose: a daemon that only seals may have no price configured at all.
 * Passing null there means legacy rows resolve to "no terms available", never
 * to an invented price. Callers surface that as an exclusion rather than
 * quoting a number nobody set.
 *
 * A null `call` (the id is unknown to this deployment) also falls back, which
 * is what the paid access path has always done: eligibility answers
 * CallNotFound a moment later, and it is the authority on that.
 */
export function termsFromSnapshot(
  call: CallTermsSnapshot | null | undefined,
  legacyTerms: CallTerms | null,
): CallTerms | null {
  if (call?.provider_price_atoms && call.provider_currency && call.provider_pricing_version) {
    return {
      priceAtoms: call.provider_price_atoms,
      currency: call.provider_currency,
      pricingVersion: call.provider_pricing_version,
    };
  }
  if (call && call.provider_terms_snapshotted === 1) return null;
  return legacyTerms;
}
