import type {
  EdgeClass,
  ResolutionClass,
} from "./feed-contract-schema.js";

export interface FeedContractMetadataInput {
  resolution_classes: readonly string[];
  edge_classes: readonly string[];
  covered_market_ids: readonly string[];
  trigger_rules: readonly unknown[];
}

export interface FeedContractMetadataJson {
  resolution_classes_json: string;
  edge_classes_json: string;
  covered_market_ids_json: string;
  trigger_rules_json: string;
}

export interface PublicFeedContractMetadata {
  resolution_classes: string[];
  edge_classes: string[];
  covered_market_ids: string[];
  trigger_rules: unknown[];
}

export function feedContractMetadataJson(
  input: FeedContractMetadataInput,
): FeedContractMetadataJson {
  return {
    resolution_classes_json: JSON.stringify(input.resolution_classes),
    edge_classes_json: JSON.stringify(input.edge_classes),
    covered_market_ids_json: JSON.stringify(input.covered_market_ids),
    trigger_rules_json: JSON.stringify(input.trigger_rules),
  };
}

export function publicFeedContractMetadata(
  row: FeedContractMetadataJson,
): PublicFeedContractMetadata {
  return {
    resolution_classes: parseJsonField<string[]>(
      row.resolution_classes_json,
      "feed.resolution_classes_json",
    ),
    edge_classes: parseJsonField<string[]>(
      row.edge_classes_json,
      "feed.edge_classes_json",
    ),
    covered_market_ids: parseJsonField<string[]>(
      row.covered_market_ids_json,
      "feed.covered_market_ids_json",
    ),
    trigger_rules: parseJsonField<unknown[]>(
      row.trigger_rules_json,
      "feed.trigger_rules_json",
    ),
  };
}

export function coveredMarketIdsForFeed(row: Pick<
  FeedContractMetadataJson,
  "covered_market_ids_json"
>): string[] {
  return safeJsonArray<string>(row.covered_market_ids_json);
}

export function feedHasEdgeClass(
  row: Pick<FeedContractMetadataJson, "edge_classes_json">,
  edgeClass: EdgeClass | null | undefined,
): boolean {
  return (
    !edgeClass ||
    safeJsonArray<string>(row.edge_classes_json).includes(edgeClass)
  );
}

export function feedHasResolutionClass(
  row: Pick<FeedContractMetadataJson, "resolution_classes_json">,
  resolutionClass: ResolutionClass | null | undefined,
): boolean {
  return (
    !resolutionClass ||
    safeJsonArray<string>(row.resolution_classes_json).includes(resolutionClass)
  );
}

function parseJsonField<T>(raw: string, field: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(
      `${field} is malformed JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function safeJsonArray<T>(raw: string): T[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}
