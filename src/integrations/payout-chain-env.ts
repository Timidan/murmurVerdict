// ─── The chain, as the payout worker needs to see it ────────────────────────
//
// An interface rather than a direct viem import, for the same reason
// fhenix-grant-env.ts is one: the worker's job is deciding WHETHER and WHEN to
// send money, and that logic has to be testable against a scripted chain — one
// that can drop a broadcast, return a receipt for a transaction the worker
// never saw succeed, or go unreadable at exactly the wrong moment.
//
// The split that matters is between SIGNING and SENDING. They are separate
// calls because the bytes must be durably written down before anything is
// broadcast; an adapter that signed-and-sent in one step would make that
// impossible to arrange.

export interface SignedTransfer {
  /** The raw signed transaction, ready to broadcast, and to REbroadcast. */
  raw: string;
  /** Its hash, known before it is sent. */
  hash: string;
  nonce: number;
}

export interface TransferReceipt {
  blockNumber: number;
  success: boolean;
  /** Depth including its own block. Gates finality before anything is terminal. */
  confirmations: number;
  /**
   * Whether this receipt carries an ERC-20 Transfer of the exact amount, from
   * the sender, to the destination.
   *
   * A successful receipt is NOT enough on its own: a transaction can succeed
   * while moving nothing, or moving something else. The journal says money
   * arrived, so something has to have checked that it did.
   */
  matchedTransfer: boolean;
}

export interface PayoutChainAdapter {
  readonly chainId: number;
  readonly tokenAddress: string;
  readonly senderAddress: string;

  /** Next nonce the chain expects, counting transactions already in the pool. */
  getPendingNonce(): Promise<number>;

  /**
   * Sign an ERC-20 transfer. MUST NOT broadcast: the caller persists the bytes
   * first, so that a crash between signing and sending cannot lose track of a
   * transaction that may yet be mined.
   */
  signTransfer(input: {
    to: string;
    amountAtoms: bigint;
    nonce: number;
  }): Promise<SignedTransfer>;

  /**
   * Broadcast raw bytes. Rebroadcasting the SAME bytes must be safe — that is
   * the whole recovery path, and nodes treat a duplicate as already-known
   * rather than as a second transfer.
   */
  broadcast(raw: string): Promise<void>;

  /** null when not yet mined. Throws when the chain cannot be read at all. */
  getReceipt(
    txHash: string,
    expect: { to: string; amountAtoms: bigint },
  ): Promise<TransferReceipt | null>;

  /** Liquid token balance of the sender. Gateway credit is NOT counted here. */
  getTokenBalance(): Promise<bigint>;

  /** Native balance, for gas. A payout worker that cannot pay gas is stuck. */
  getGasBalanceWei(): Promise<bigint>;
}
