// dashboard/src/verdict/components/Splash.tsx
//
// Full-bleed first-paint splash. Removes itself after the first useEffect
// fires (i.e., after React has hydrated and run the first paint).
// `.nothing-live` triggers the breathe animation only when
// prefers-reduced-motion is no-preference (see styles.css).

import { useEffect, useState } from "react";
import { MMark } from "./MMark.js";

export function Splash() {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const id = requestAnimationFrame(() => setVisible(false));
    return () => cancelAnimationFrame(id);
  }, []);

  if (!visible) return null;

  return (
    <div
      role="status"
      aria-label="Loading Murmur Verdict"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        background: "var(--color-bg)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <MMark size={96} decorative className="nothing-live" />
    </div>
  );
}
