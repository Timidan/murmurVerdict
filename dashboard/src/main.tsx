import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import "./verdict/styles/compact.css";
import "./verdict/styles/calm.css";
import { VerdictRouter } from "./verdict/Router.js";
import { PrivyProvider } from "./verdict/auth/PrivyProvider.js";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PrivyProvider>
      <VerdictRouter />
    </PrivyProvider>
  </StrictMode>,
);
