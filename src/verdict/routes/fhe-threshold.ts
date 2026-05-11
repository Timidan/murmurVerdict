/**
 * Z3 — FHE threshold-decrypt routes.
 *
 * Three surfaces ship in this wave:
 *
 *   GET  /v1/calls/:id/fhe-transcript
 *        Public read of the threshold-decrypt transcript: request
 *        status, score_ciphertext_hash, transcript_hash, resolved-
 *        outcome hash, the array of (holder_id, public_identity,
 *        signature) tuples, and — once released — the bounded score.
 *        NO authentication: the transcript is the audit artifact that
 *        proves the score wasn't operator-decrypted. A future Z4 UI
 *        renders this into the OPERATOR-BLIND badge view.
 *
 *   POST /v1/fhe/decrypt-requests
 *        Daemon-internal-only. Gated by VERDICT_ADMIN_TOKEN since the
 *        normal request-creation path is the resolver tick (auto-
 *        enqueues atomically with the score commit). Exposed because
 *        an ops user may need to manually re-queue a failed request
 *        post-incident; it's not a high-traffic surface.
 *
 *   POST /v1/fhe/holders/:holder_id/shares
 *        Webhook endpoint a real (off-process) holder posts partial
 *        decrypts to. v0 accepts only from the mock pool (registered
 *        at boot via fhe_key_holders.public_identity); a real
 *        production deployment also wires HMAC / mTLS at the edge.
 *
 *        NOTE: this route's shape is locked in by Z3 so the mock
 *        pool's external-API contract is set, but the mock pool
 *        itself BYPASSES this route — it calls
 *        producePartialDecrypt() directly from the resolver. The
 *        route exists so a real off-process holder doesn't need a
 *        route migration to land.
 */
import { Router, type Request, type Response } from "express";
import express from "express";
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  getDecryptRequestByCallId,
  getDecryptRequest,
  getScoreRelease,
  listSharesForRequest,
  persistDecryptShare,
  enqueueDecryptRequest,
} from "../fhe/decrypt-requests.js";
import { verifyShare } from "../fhe/threshold.js";

export interface FheThresholdRouterDeps {
  db: Database.Database;
  /**
   * Required to gate /v1/fhe/decrypt-requests. Without an admin token
   * configured, the POST route returns 503 — there is no public
   * fallback because the resolver auto-enqueues the normal path.
   */
  adminToken?: string;
  now?: () => Date;
}

const nowIso = (now: () => Date) =>
  now().toISOString().replace(/\.\d+Z$/, "Z");

export function createFheThresholdRouter(
  deps: FheThresholdRouterDeps,
): Router {
  const router = Router();
  const now = deps.now ?? (() => new Date());
  const adminToken = deps.adminToken ?? process.env.VERDICT_ADMIN_TOKEN ?? "";
  const json = express.json({ limit: "256kb" });

  // ─── GET /v1/calls/:id/fhe-transcript ─────────────────────────────────────
  router.get("/v1/calls/:id/fhe-transcript", (req: Request, res: Response) => {
    const callId = String(req.params.id ?? "");
    const reqRow = getDecryptRequestByCallId(deps.db, callId);
    if (!reqRow) {
      // No decrypt request means either (a) the call is legacy_plaintext
      // / committed (no FHE pipeline), or (b) it's fhe_direct but
      // hasn't been scored yet. Either way 404 — the transcript only
      // exists for calls that have an active threshold request.
      res.status(404).json({
        error: "no_fhe_transcript",
        message: `no fhe_direct decrypt request for call_id=${callId}`,
      });
      return;
    }
    const shares = listSharesForRequest(deps.db, reqRow.request_id);
    const release =
      reqRow.status === "released"
        ? getScoreRelease(deps.db, reqRow.request_id)
        : null;
    // Pull each share's public_identity inline so the transcript is
    // self-contained (a third party verifying the signatures doesn't
    // need a second round-trip to /v1/agents/...).
    const holderPubs = new Map<string, string>();
    const stmt = deps.db.prepare(
      "SELECT public_identity FROM fhe_key_holders WHERE holder_id = ?",
    );
    for (const s of shares) {
      const r = stmt.get(s.holder_id) as
        | { public_identity: string }
        | undefined;
      if (r) holderPubs.set(s.holder_id, r.public_identity);
    }
    res.json({
      call_id: callId,
      request_id: reqRow.request_id,
      status: reqRow.status,
      keyset_id: reqRow.keyset_id,
      score_ciphertext_hash: reqRow.score_ciphertext_hash,
      transcript_hash: reqRow.transcript_hash,
      resolved_outcome_hash: reqRow.resolved_outcome_hash,
      created_at: reqRow.created_at,
      released_at: reqRow.released_at,
      // Status-gated: released_score is only present when status='released'.
      // No "preview" or "operator-can-decrypt-early" mode by design.
      released_score: release?.released_score ?? null,
      shares: shares.map((s) => ({
        holder_id: s.holder_id,
        public_identity: holderPubs.get(s.holder_id) ?? null,
        share_signature: s.share_signature,
        submitted_at: s.submitted_at,
      })),
    });
  });

  // ─── POST /v1/fhe/decrypt-requests ────────────────────────────────────────
  router.post(
    "/v1/fhe/decrypt-requests",
    json,
    (req: Request, res: Response) => {
      if (!adminToken) {
        res.status(503).json({
          error: "admin_token_not_configured",
          message:
            "VERDICT_ADMIN_TOKEN must be set to use the daemon-internal decrypt-request route",
        });
        return;
      }
      const authz = req.header("Authorization") ?? req.header("authorization");
      const tok = authz?.startsWith("Bearer ") ? authz.slice(7) : null;
      if (!tok || tok !== adminToken) {
        res
          .status(401)
          .json({ error: "unauthorized", message: "admin token required" });
        return;
      }
      const body = req.body as Record<string, unknown> | undefined;
      const callId = typeof body?.call_id === "string" ? body.call_id : null;
      const sch =
        typeof body?.score_ciphertext_hash === "string"
          ? body.score_ciphertext_hash
          : null;
      const th =
        typeof body?.transcript_hash === "string" ? body.transcript_hash : null;
      const roh =
        typeof body?.resolved_outcome_hash === "string"
          ? body.resolved_outcome_hash
          : null;
      const ksid =
        typeof body?.keyset_id === "string" ? body.keyset_id : null;
      if (!callId || !sch || !th || !roh || !ksid) {
        res.status(400).json({
          error: "schema_invalid",
          message:
            "body must include call_id, score_ciphertext_hash, transcript_hash, resolved_outcome_hash, keyset_id",
        });
        return;
      }
      const requestId = enqueueDecryptRequest({
        db: deps.db,
        request_id: `dreq_${randomUUID()}`,
        call_id: callId,
        score_ciphertext_hash: sch,
        transcript_hash: th,
        resolved_outcome_hash: roh,
        keyset_id: ksid,
        now: nowIso(now),
      });
      res.status(201).json({ request_id: requestId, status: "pending_shares" });
    },
  );

  // ─── POST /v1/fhe/holders/:holder_id/shares ───────────────────────────────
  router.post(
    "/v1/fhe/holders/:holder_id/shares",
    json,
    (req: Request, res: Response) => {
      // Body shape: { request_id, partial_decrypt_hex, share_signature }
      const holderId = String(req.params.holder_id ?? "");
      const body = req.body as Record<string, unknown> | undefined;
      const requestId =
        typeof body?.request_id === "string" ? body.request_id : null;
      const partialHex =
        typeof body?.partial_decrypt_hex === "string"
          ? body.partial_decrypt_hex
          : null;
      const sig =
        typeof body?.share_signature === "string" ? body.share_signature : null;
      if (!requestId || !partialHex || !sig) {
        res.status(400).json({
          error: "schema_invalid",
          message:
            "body must include request_id, partial_decrypt_hex, share_signature",
        });
        return;
      }
      const reqRow = getDecryptRequest(deps.db, requestId);
      if (!reqRow) {
        res
          .status(404)
          .json({ error: "unknown_request", message: requestId });
        return;
      }
      // v0 hard rule: the mock pool bypasses this route entirely, so
      // any inbound POST is either a real off-process holder (not
      // shipped yet) or an unauthenticated probe. We refuse with 501
      // until Z3b's real-holder integration lands. The route's shape
      // is locked in so the future change is wire-compat.
      const holderRow = deps.db
        .prepare(
          `SELECT public_identity, enabled FROM fhe_key_holders
           WHERE holder_id = ?`,
        )
        .get(holderId) as
        | { public_identity: string; enabled: number }
        | undefined;
      if (!holderRow || holderRow.enabled !== 1) {
        res
          .status(404)
          .json({ error: "unknown_holder", message: holderId });
        return;
      }
      // Defense in depth: only accept the share if the signature
      // verifies under the registered public identity AND we're
      // configured to accept external shares. v0 has no such config
      // flag yet; reject all.
      const acceptExternalShares =
        process.env.MURMUR_FHE_ACCEPT_EXTERNAL_SHARES === "1";
      if (!acceptExternalShares) {
        res.status(501).json({
          error: "external_shares_disabled",
          message:
            "external holder shares are accepted only via the mock pool in v0; real holder integration ships with Zama KMS",
        });
        return;
      }
      const partial = Buffer.from(partialHex, "hex");
      const okSig = verifyShare(
        {
          holder_id: holderId,
          category: "attester", // category unused by verifyShare
          partial_decrypt: partial,
          share_signature: sig,
        },
        holderRow.public_identity,
        reqRow.transcript_hash,
      );
      if (!okSig) {
        res
          .status(400)
          .json({ error: "bad_signature", message: "ed25519 verify failed" });
        return;
      }
      persistDecryptShare({
        db: deps.db,
        share_id: `dshr_${randomUUID()}`,
        request_id: requestId,
        holder_id: holderId,
        partial_decrypt: partial,
        share_signature: sig,
        now: nowIso(now),
      });
      res.status(202).json({ accepted: true });
    },
  );

  return router;
}
