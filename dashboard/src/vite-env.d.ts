/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ARBITRUM_RPC_URL?: string;
  readonly VITE_TRIGGER_URL?: string;
  readonly VITE_WS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
