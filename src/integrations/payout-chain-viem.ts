// ─── The payout adapter, against a real chain ───────────────────────────────
//
// Implements PayoutChainAdapter with viem. It holds the one key in this system
// that can move money out, so it is deliberately narrow: it can sign a
// transfer of an ERC-20 to an address, broadcast bytes, and read receipts.
// Nothing else.
//
// NOTE the split between signTransfer and broadcast: the worker persists the
// signed bytes before sending them, so `writeContract` (which signs AND sends)
// is exactly what must not be used here.

import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeFunctionData,
  http,
  parseAbi,
  type Address,
  type Hex,
  type LocalAccount,
} from "viem";

import type {
  PayoutChainAdapter,
  SignedTransfer,
  TransferReceipt,
} from "./payout-chain-env.js";

const ERC20_ABI = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export interface ViemPayoutAdapterInput {
  chainId: number;
  rpcUrl: string;
  tokenAddress: Address;
  /** Raw-key or KMS-backed; this adapter only ever asks it to sign. */
  account: LocalAccount;
  /** Gas ceiling per transfer. A plain ERC-20 transfer is well under this. */
  gasLimit?: bigint;
}

export function createViemPayoutChainAdapter(
  input: ViemPayoutAdapterInput,
): PayoutChainAdapter {
  // The account carries no `nonceManager`: this adapter must NOT manage
  // nonces. The outbox owns them, because a nonce has to survive a process
  // restart and an in-memory manager does not.
  const account = input.account;
  const publicClient = createPublicClient({ transport: http(input.rpcUrl) });
  const walletClient = createWalletClient({ account, transport: http(input.rpcUrl) });
  const gasLimit = input.gasLimit ?? 120_000n;

  return {
    chainId: input.chainId,
    tokenAddress: input.tokenAddress.toLowerCase(),
    senderAddress: account.address.toLowerCase(),

    async getPendingNonce() {
      return publicClient.getTransactionCount({
        address: account.address,
        blockTag: "pending",
      });
    },

    async signTransfer({ to, amountAtoms, nonce }): Promise<SignedTransfer> {
      const data = encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "transfer",
        args: [to as Address, amountAtoms],
      });
      const fees = await publicClient.estimateFeesPerGas();
      const raw = await walletClient.signTransaction({
        account,
        chain: null,
        to: input.tokenAddress,
        data,
        nonce,
        gas: gasLimit,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        chainId: input.chainId,
      });
      // The hash is derivable from the bytes, so it is known before sending —
      // which is what lets the worker record what it is about to broadcast.
      const { keccak256 } = await import("viem");
      return { raw, hash: keccak256(raw), nonce };
    },

    async broadcast(raw: string) {
      await publicClient.sendRawTransaction({ serializedTransaction: raw as Hex });
    },

    async getReceipt(txHash, expect): Promise<TransferReceipt | null> {
      let receipt;
      try {
        receipt = await publicClient.getTransactionReceipt({ hash: txHash as Hex });
      } catch {
        // viem throws TransactionReceiptNotFoundError for an unmined hash.
        // That is "not yet", not "cannot read" — a genuine RPC failure is
        // re-thrown below by the head read.
        const head = await publicClient.getBlockNumber();
        void head;
        return null;
      }
      const head = await publicClient.getBlockNumber();
      const confirmations = Number(head - receipt.blockNumber) + 1;

      // A successful receipt is not proof that this transfer happened: the
      // call could have returned false, or moved a different amount. Find the
      // actual Transfer log and check it.
      let matchedTransfer = false;
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== input.tokenAddress.toLowerCase()) continue;
        try {
          const decoded = decodeEventLog({
            abi: ERC20_ABI,
            data: log.data,
            topics: log.topics,
          });
          if (decoded.eventName !== "Transfer") continue;
          const args = decoded.args as unknown as {
            from: string;
            to: string;
            value: bigint;
          };
          if (
            args.from.toLowerCase() === account.address.toLowerCase() &&
            args.to.toLowerCase() === expect.to.toLowerCase() &&
            args.value === expect.amountAtoms
          ) {
            matchedTransfer = true;
            break;
          }
        } catch {
          // Not a Transfer from this token. Keep looking.
        }
      }

      return {
        blockNumber: Number(receipt.blockNumber),
        success: receipt.status === "success",
        confirmations,
        matchedTransfer,
      };
    },

    async getTokenBalance() {
      return publicClient.readContract({
        address: input.tokenAddress,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account.address],
      });
    },

    async getGasBalanceWei() {
      return publicClient.getBalance({ address: account.address });
    },
  };
}
