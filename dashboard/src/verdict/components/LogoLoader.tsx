// Looping brand mark for full-page waits — the first ~0.7s of the logo sting.
// Animated WebP with a real alpha channel: no blend mode, so it stays
// transparent over any background and inside any stacking context.

const LOOP_SRC = "/brand/logo-loop.webp";
const STILL_SRC = "/brand/logo-loop-still.png";

export function LogoLoader({
  label = "Loading",
  width = 420,
  className = "",
}: {
  label?: string;
  width?: number;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-label={label}
      className={"mmr-logo-loader " + className}
      style={{ ["--loader-w" as string]: `${width}px` }}
    >
      <img className="mmr-logo-loader-anim" src={LOOP_SRC} alt="" aria-hidden="true" />
      <img className="mmr-logo-loader-still" src={STILL_SRC} alt="" aria-hidden="true" />
    </div>
  );
}

/** Full-page variant for Suspense and the auth gate. */
export function LogoLoaderScreen({ label = "Loading" }: { label?: string }) {
  return <LogoLoader label={label} />;
}
