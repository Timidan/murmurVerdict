import { Router } from "express";

import { sendCacheablePublicResource } from "../public-cache-response.js";
import { publicSyndicationMediaEndpoints } from "../public-syndication-media-policy.js";
import { publicSyndicationMediaResource } from "../public-syndication-media-surface.js";
import type { SyndicationRouterDeps } from "./syndication-types.js";

export function syndicationMediaRouter(deps: SyndicationRouterDeps): Router {
  const router = Router();

  for (const endpoint of publicSyndicationMediaEndpoints()) {
    router.get(endpoint.path, (req, res) => {
      sendCacheablePublicResource(req, res, publicSyndicationMediaResource({
        db: deps.db,
        slug: String(req.params.slug ?? ""),
        variant: endpoint.variant,
        format: endpoint.format,
      }));
    });
  }

  return router;
}
