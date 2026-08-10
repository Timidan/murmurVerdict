import { strict as assert } from "node:assert";

import {
  httpsUrlOrNull,
  marketConfigSchema,
  polymarketGammaMarketConfig,
  publicPolymarketGammaMarketConfigSummary,
} from "./config.js";
import {
  enrichedMarketRegistryRow,
  publicMarketConfigSummary,
} from "../../verdict/market-registry-public.js";
import type { GammaMarketSnapshot } from "./transform.js";

process.stdout.write("murmur Polymarket market icon passthrough smoke\n");

const conditionId = `0x${"b".repeat(64)}`;
const ICON = "https://polymarket-upload.s3.us-east-2.amazonaws.com/SOL+fullsize.png";
const IMAGE = "https://polymarket-upload.s3.us-east-2.amazonaws.com/SOL+card.png";

function configFor(extra: Record<string, unknown>) {
  return polymarketGammaMarketConfig({
    conditionId,
    snapshot: {
      slug: "sol-updown-5m-1786340400",
      outcomes: JSON.stringify(["Up", "Down"]),
      endDate: "2026-08-10T05:45:00Z",
      ...extra,
    },
  });
}

// ─── 1. The field is typed on the snapshot, not smuggled through the index
//        signature. If `icon`/`image` ever stop being first-class this stops
//        compiling, which is the point — a typo'd field name would otherwise
//        silently produce iconless markets forever.
const typedSnapshot: Pick<GammaMarketSnapshot, "icon" | "image"> = {
  icon: ICON,
  image: IMAGE,
};
assert.equal(typedSnapshot.icon, ICON);

// ─── 2. `icon` wins; `image` is the fallback ────────────────────────────────

assert.equal(configFor({ icon: ICON, image: IMAGE }).icon_url, ICON);
assert.equal(configFor({ image: IMAGE }).icon_url, IMAGE, "image is the fallback");
assert.equal(
  configFor({ icon: "", image: IMAGE }).icon_url,
  IMAGE,
  "an empty icon falls through to image rather than storing nothing",
);

// ─── 3. Non-https is REJECTED at ingestion ──────────────────────────────────
//
// Every one of these is a real hazard, not a hypothetical: http downgrades the
// public page to mixed content (browsers block it outright), and the
// javascript:/data: forms are script injection handed to us by an upstream we
// do not control.

for (const hostile of [
  "http://polymarket-upload.s3.amazonaws.com/SOL.png",
  "javascript:alert(1)",
  "data:image/svg+xml;base64,PHN2Zy8+",
  "//protocol-relative.example/icon.png",
  "ftp://example.com/icon.png",
  "  ",
  "not a url at all",
  42,
  null,
  {},
  ["https://example.com/a.png"],
]) {
  assert.equal(
    httpsUrlOrNull(hostile),
    null,
    `non-https candidate rejected: ${String(hostile)}`,
  );
  const config = configFor({ icon: hostile });
  assert.equal(
    "icon_url" in config,
    false,
    `a market whose only artwork is ${String(hostile)} stores NO icon_url`,
  );
}

// A hostile `icon` still lets a good `image` through — one bad field must not
// cost the market its artwork.
assert.equal(
  configFor({ icon: "http://insecure.example/a.png", image: IMAGE }).icon_url,
  IMAGE,
);

// Rejecting the icon never rejects the MARKET. Artwork is display metadata;
// refusing to register a tradeable market over a bad image URL would be a far
// worse failure than showing a letter glyph.
{
  const config = configFor({ icon: "javascript:alert(1)" });
  assert.equal(config.conditionId, conditionId);
  assert.equal(config.slug, "sol-updown-5m-1786340400");
  assert.deepEqual(config.outcomes, ["Up", "Down"]);
}

// ─── 4. No icon at all — and NO backfill ────────────────────────────────────

{
  const config = configFor({});
  assert.equal("icon_url" in config, false, "absent artwork stores no key");
  assert.deepEqual(marketConfigSchema.parse(config), config);
}

// ─── 5. The stored projection validates ─────────────────────────────────────

{
  const config = configFor({ icon: ICON });
  assert.deepEqual(marketConfigSchema.parse(config), config);
  // The schema itself refuses a non-https value, so a hand-edited or
  // hand-written config cannot validate its way in either.
  assert.throws(
    () => marketConfigSchema.parse({ ...config, icon_url: "http://x.example/a.png" }),
    /icon_url must be an https URL/,
  );
}

// ─── 6. The PUBLIC summary carries it ───────────────────────────────────────
//
// This is the half that was missing: the value was stored but the summary
// omitted it, so every consumer reading the public projection saw no artwork.

{
  const config = configFor({ icon: ICON });
  const summary = publicPolymarketGammaMarketConfigSummary({
    ...config,
    private_note: "do not expose",
  });
  assert.equal(summary.icon_url, ICON);
  assert.equal("private_note" in summary, false, "the summary stays a whitelist");

  // And through the adapter-dispatching entry point the read surfaces use.
  const viaRegistry = publicMarketConfigSummary(JSON.stringify(config), {
    adapter_id: "polymarket-gamma",
  });
  assert.equal(viaRegistry.icon_url, ICON);
}

// A row that predates the ingestion guard (or was written by hand) cannot put
// a non-https url onto the public page: the summary re-validates on the way
// out, independently of what storage happens to hold.
{
  const summary = publicPolymarketGammaMarketConfigSummary({
    conditionId,
    slug: "legacy",
    icon_url: "http://insecure.example/icon.png",
  });
  assert.equal("icon_url" in summary, false, "the read path re-checks the scheme");
}

// A market with no artwork produces no key, so consumers can rely on
// `icon_url === undefined` meaning "render the glyph".
{
  const summary = publicPolymarketGammaMarketConfigSummary(configFor({}));
  assert.equal("icon_url" in summary, false);
}

// ─── 7. The ENRICHED read row sanitizes too ─────────────────────────────────
//
// `enrichedMarketRegistryRow` spread the raw MarketRow, so `config_json` went
// to the wire verbatim — right past the summary's validated gate. The dashboard
// parses that blob itself and puts `icon_url` into an <img src>, so the gate
// only ever covered one of the two shapes murmur serves.

function enrichedConfig(iconUrl: unknown): Record<string, unknown> {
  const stored: Record<string, unknown> = {
    conditionId,
    slug: "sol-updown-5m-1786340400",
    outcomes: ["Up", "Down"],
    endDate: "2026-08-10T05:45:00Z",
    gamma_url: "https://polymarket.com/event/sol-updown-5m-1786340400",
  };
  if (iconUrl !== undefined) stored.icon_url = iconUrl;
  const row = enrichedMarketRegistryRow({
    market_id: conditionId,
    config_json: JSON.stringify(stored),
  } as unknown as Parameters<typeof enrichedMarketRegistryRow>[0]);
  return JSON.parse(row.config_json) as Record<string, unknown>;
}

// A bare scheme is the exact value the dashboard's old `/^https:\/\//` prefix
// test let through and `new URL()` rejects — it has no host, so it renders as a
// broken image at best.
for (const hostile of [
  "https://",
  "https:///",
  "http://insecure.example/icon.png",
  "javascript:alert(1)",
  "data:image/svg+xml;base64,PHN2Zy8+",
  "//protocol-relative.example/icon.png",
  "   ",
  42,
  null,
]) {
  assert.equal(
    "icon_url" in enrichedConfig(hostile),
    false,
    `the enriched read path drops ${JSON.stringify(hostile)}`,
  );
}

// A real icon survives, and the rest of the blob is untouched.
{
  const config = enrichedConfig(ICON);
  assert.equal(config.icon_url, ICON);
  assert.equal(config.slug, "sol-updown-5m-1786340400");
  assert.deepEqual(config.outcomes, ["Up", "Down"]);
  assert.equal(config.gamma_url, "https://polymarket.com/event/sol-updown-5m-1786340400");
}

// No key in, no key out — never a null the renderer would have to special-case.
assert.equal("icon_url" in enrichedConfig(undefined), false);

// An unparseable blob is passed through rather than rewritten: it carries no
// readable icon anyway, and inventing a replacement would be worse.
{
  const row = enrichedMarketRegistryRow({
    market_id: conditionId,
    config_json: "{not json",
  } as unknown as Parameters<typeof enrichedMarketRegistryRow>[0]);
  assert.equal(row.config_json, "{not json");
}

// The browser-side half of this gate is pinned separately, in
// dashboard/src/verdict/lib/market-meta.smoke.ts — the root tsconfig sets
// `rootDir: ./src` and excludes `dashboard`, so it cannot be imported here.

process.stdout.write("OK Polymarket market icon passthrough smoke\n");
