import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import "./verdict/styles/compact.css";
import "./verdict/styles/animated-mark.css";
import { VerdictRouter } from "./verdict/Router.js";
import { Splash } from "./verdict/components/Splash.js";

// No PrivyProvider here: it mounts in auth/AccountShell.tsx so public routes never ship the SDK.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Splash />
    <VerdictRouter />
  </StrictMode>,
);
