import { keccak256, toBytes } from "viem";

export function fhenixFeedIdForMurmurFeed(feedId: string): string {
  if (/^0x[0-9a-fA-F]{64}$/.test(feedId)) return feedId.toLowerCase();
  return keccak256(toBytes(feedId)).toLowerCase();
}
