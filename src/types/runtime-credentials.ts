export const RUNTIME_KEY_SENTINEL = "__MURMUR_RUNTIME_KEY__";
export const RUNTIME_KEY_ID_SENTINEL = "__MURMUR_RUNTIME_KEY_ID__";
export const RUNTIME_KEY_SIGNING_PK_SENTINEL = "__MURMUR_RUNTIME_KEY_SIGNING_PK__";

const RUNTIME_KEY_PLACEHOLDER =
  "<your mrt_… runtime key — mint one under Account → runtime keys>";
const RUNTIME_KEY_ID_PLACEHOLDER = "<the runtime_key_id shown at mint>";
const SIGNING_PK_PLACEHOLDER =
  "<the ed25519 signing key shown at mint — unrecoverable, mint a new key if lost>";

export interface RuntimeCredentials {
  runtimeKey?: string;
  signingPrivateKey?: string | null;
  runtimeKeyId?: string | null;
}

const fill = (value: string | null | undefined, placeholder: string): string =>
  value && value.length > 0 ? value : placeholder;

/** Fill all one-time credentials into the server-rendered prompt. */
export function injectRuntimeCredentials(
  template: string,
  credentials: RuntimeCredentials = {},
): string {
  const values = [
    credentials.runtimeKey,
    credentials.runtimeKeyId,
    credentials.signingPrivateKey,
  ];
  const hasCredentials = values.some((value) => value != null);
  const hasCompleteCredentials = values.every(
    (value) => typeof value === "string" && value.length > 0,
  );

  if (hasCredentials && !hasCompleteCredentials) {
    return `# Murmur Runtime Key

STOP: this credential handoff is incomplete. Ask your owner to revoke this
key and mint a new proof-of-possession Runtime Key. Do not run the submit flow.
`;
  }

  return template
    .replaceAll(
      RUNTIME_KEY_SENTINEL,
      fill(credentials.runtimeKey, RUNTIME_KEY_PLACEHOLDER),
    )
    .replaceAll(
      RUNTIME_KEY_ID_SENTINEL,
      fill(credentials.runtimeKeyId, RUNTIME_KEY_ID_PLACEHOLDER),
    )
    .replaceAll(
      RUNTIME_KEY_SIGNING_PK_SENTINEL,
      fill(credentials.signingPrivateKey, SIGNING_PK_PLACEHOLDER),
    );
}
