import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import "./verdict/styles/compact.css";
import "./verdict/styles/calm.css";
import { VerdictRouter } from "./verdict/Router.js";

// Codex P2 from Phase 7a review: Privy SDK was being loaded on every
// route via a top-level <PrivyProvider> wrap. The provider now mounts
// only when the router resolves an /account/* route — see
// dashboard/src/verdict/auth/AccountShell.tsx, lazy-imported from
// Router so landing / leaderboard / today never ship the SDK.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <VerdictRouter />
  </StrictMode>,
);
