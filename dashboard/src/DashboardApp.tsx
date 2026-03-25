import { WagmiProvider } from "wagmi";
import { baseSepolia } from "wagmi/chains";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RainbowKitProvider, getDefaultConfig } from "@rainbow-me/rainbowkit";
import { http } from "wagmi";
import "@rainbow-me/rainbowkit/styles.css";
import "./styles/terminal.css";
import { App } from "./App";

const BASE_SEPOLIA_RPC =
  (import.meta as any).env?.VITE_BASE_RPC_URL ||
  "https://base-sepolia-rpc.publicnode.com";

const config = getDefaultConfig({
  appName: "Murmur",
  projectId: "4ef92de0a4db844630626a0a9238350b",
  chains: [baseSepolia],
  transports: { [baseSepolia.id]: http(BASE_SEPOLIA_RPC) },
});

const queryClient = new QueryClient();

export function DashboardApp() {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider>
          <App />
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
