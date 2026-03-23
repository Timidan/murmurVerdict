import { StrictMode, useState, useEffect, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";

const Landing = lazy(() => import("./pages/Landing").then(m => ({ default: m.Landing })));

const DashboardApp = lazy(() => import("./DashboardApp").then(m => ({ default: m.DashboardApp })));

function Router() {
  const [route, setRoute] = useState(window.location.hash);

  useEffect(() => {
    const onHash = () => setRoute(window.location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const isDashboard = route === "#/app" || route.startsWith("#/app/");

  return (
    <Suspense fallback={<div style={{ background: "#09090b", minHeight: "100dvh" }} />}>
      {isDashboard ? <DashboardApp /> : <Landing />}
    </Suspense>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Router />
  </StrictMode>,
);
