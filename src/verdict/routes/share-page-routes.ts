import { Router } from "express";

import { publicApiUrlForRequest } from "../public-origin.js";
import {
  publicSharePageResponse,
  sendPublicSharePageResponse,
} from "../public-share-page-surface.js";
import type { SyndicationRouterDeps } from "./syndication-types.js";

export function sharePageRouter(deps: SyndicationRouterDeps): Router {
  const router = Router();

  router.get("/share/:slug", (req, res) => {
    sendPublicSharePageResponse(res, publicSharePageResponse({
      db: deps.db,
      slug: String(req.params.slug ?? ""),
      ref: req.query.ref,
      publicOrigin: deps.publicOrigin,
      apiOrigin: publicApiUrlForRequest(deps.publicOrigin, req),
    }));
  });

  return router;
}
