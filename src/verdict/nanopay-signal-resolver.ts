import type Database from "better-sqlite3";
import { agentsRepo } from "./repos/agents-repo.js";
import { fhenixLifecycleReadRepo } from "./repos/fhenix-lifecycle-read-repo.js";
import type { NanopayPipelineAgentBinding } from "./nanopay-config.js";
import type { NanopayRouterDeps } from "./nanopay-types.js";
import type { FhenixAnchorTuple } from "./single-stream-binding.js";

export interface NanopaySignalResolverDeps {
  db: Database.Database;
  pipelineAgentMap: Map<string, NanopayPipelineAgentBinding>;
  logger?: Pick<typeof console, "warn">;
}

export function createNanopaySignalResolver(
  deps: NanopaySignalResolverDeps,
): NanopayRouterDeps["resolveLatestSealedCall"] {
  const logger = deps.logger ?? console;
  return (pipelineId) => {
    const mapping = deps.pipelineAgentMap.get(pipelineId.toLowerCase());
    if (!mapping) return null;

    const row = fhenixLifecycleReadRepo.latestSealedCallForPipeline(deps.db, {
      agentId: mapping.agentId,
      marketId: mapping.marketId,
    });
    if (!row) return null;

    const agent = agentsRepo.byId(deps.db, mapping.agentId);
    const walletAddress = agent?.wallet_address ?? null;
    if (!walletAddress) {
      logger.warn(
        `[nanopay] pipeline ${pipelineId} -> agent ${mapping.agentId} has no wallet_address; cannot build binding anchor. Returning null (route will 503).`,
      );
      return null;
    }

    const anchor: FhenixAnchorTuple = {
      bindingVersion: 1,
      chainId: row.chain_id,
      sealedVerdictsContractAddress: row.contract_address as `0x${string}`,
      onchainCallId: row.onchain_call_id as `0x${string}`,
      marketId: row.market_id,
      agent: walletAddress as `0x${string}`,
      submitTxHash: row.submit_tx_hash as `0x${string}`,
      submitLogIndex: row.submit_log_index,
      binaryIndexCiphertextHash: row.binary_index_ct_hash as `0x${string}`,
      confidenceCiphertextHash: row.confidence_ct_hash as `0x${string}`,
      revealOpenAt: row.reveal_open_at,
      commitScheme: row.commit_scheme,
      commitHash: row.commit_hash,
    };
    // revealArtifact is null regardless. Materializing the
    // artifact when `fhenix_sealed_calls.revealed_at IS NOT NULL` is later
    // reconciler work.
    return { anchor, revealArtifact: null };
  };
}
