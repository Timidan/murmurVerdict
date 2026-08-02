// Client-side Ed25519 keypair for proof-of-possession runtime keys. The
// private key is generated in the browser, embedded (public half) into the
// controller-signed policy, and NEVER sent to the server — the agent host
// stores the pkcs8 export and signs each gateway request with it.
//
// WebCrypto Ed25519 needs a modern browser (Safari 17+, Firefox 129+,
// Chrome 137+). Unsupported browsers get an explicit error — never a silent
// downgrade to a bearer-only key.

export interface GeneratedRuntimeKeySigning {
  /** 32-byte raw public key, 64 lowercase hex — goes into policy.signing_pubkey. */
  publicKeyHex: string;
  /** PKCS8 DER, base64 — what the agent host stores. Node loads it with
   *  crypto.createPrivateKey({ key: Buffer.from(v, "base64"), format: "der",
   *  type: "pkcs8" }). */
  privateKeyPkcs8Base64: string;
}

export async function generateRuntimeKeySigningKeypair(): Promise<GeneratedRuntimeKeySigning> {
  if (!globalThis.isSecureContext || !crypto?.subtle) {
    throw new Error(
      "request-signing keys need a secure context (https) with WebCrypto",
    );
  }
  let pair: CryptoKeyPair;
  try {
    pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
  } catch {
    throw new Error(
      "this browser cannot generate Ed25519 signing keys (needs Safari 17+, Firefox 129+, or Chrome 137+) — update the browser, or untick request signing to mint a bearer-only key",
    );
  }
  const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  return {
    publicKeyHex: [...rawPub].map((b) => b.toString(16).padStart(2, "0")).join(""),
    privateKeyPkcs8Base64: btoa(String.fromCharCode(...pkcs8)),
  };
}
