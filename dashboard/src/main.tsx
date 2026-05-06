import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { VerdictRouter } from "./verdict/Router.js";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <VerdictRouter />
  </StrictMode>,
);
