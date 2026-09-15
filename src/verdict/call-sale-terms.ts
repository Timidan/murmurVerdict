// ─── The terms one sealed call is sold under ────────────────────────────────
//
// Pure: snapshot in, terms or null out. Shared by entitlement-access-surface.termsFor() (what a buyer
// is charged) and gateway-sellable-surface (what the storefront advertises) so the two can't drift.

export interface CallTerms {
  priceAtoms: string;
  currency: string;
  pricingVersion: string;
}

/** The provider-terms columns this reads; FhenixSealedCallRow satisfies it. */
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
 * The terms this call is sold under, or null when it is not for sale.
 * Uses the call's own snapshot (price at seal time), so later repricing can't change an offered call.
 * No snapshot: flag 0 (sealed before provider pricing) falls back to `legacyTerms`; flag 1 (owner set
 * or cleared no terms) is not for sale. Null `legacyTerms` means no terms, never an invented price.
 * A null `call` (unknown id) also falls back; eligibility answers CallNotFound.
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
