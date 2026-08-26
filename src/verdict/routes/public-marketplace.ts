import { Router } from "express";
import type Database from "better-sqlite3";

import { marketplaceListingsResponse } from "../marketplace-listings-surface.js";
import { parseMarketplaceListingFilters } from "../marketplace-listings-query.js";

export interface PublicMarketplaceRouterDeps {
  db: Database.Database;
  now: () => Date;
}

// Discovery is public. Auth belongs at checkout, where money moves — gating the
// catalog would hide the offers from exactly the buyers who have not signed up
// yet. Nothing here is private: a standing price is what the seller published.
const MARKETPLACE_CACHE_CONTROL = "public, max-age=30, stale-while-revalidate=120";

export function publicMarketplaceRouter(deps: PublicMarketplaceRouterDeps): Router {
  const router = Router();

  router.get("/v1/marketplace/listings", (req, res) => {
    const parsed = parseMarketplaceListingFilters(
      req.query as Record<string, unknown> | undefined,
    );
    if (!parsed.ok) {
      res.status(400).json(parsed.problem);
      return;
    }
    const result = marketplaceListingsResponse(
      { db: deps.db, now: deps.now },
      parsed.filters,
    );
    res.setHeader("Cache-Control", MARKETPLACE_CACHE_CONTROL);
    res.status(result.status).json(result.body);
  });

  return router;
}
