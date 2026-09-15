// Animated SVG of the Murmur M mark plus optional wordmark; CSS keyframes only.
// One 6400ms timeline loops; `once` starts it at the respawn beat via a negative
// delay and holds on the assembled mark. Geometry mirrors MMark.tsx.

export interface AnimatedMarkProps {
  /** px size of the square mark area. */
  size?: number;
  /** "once" plays the assembly and holds; "loop" repeats the full cycle. */
  mode?: "once" | "loop";
  showWordmark?: boolean;
  className?: string;
}

// The per-bar BAR_Y stagger is what makes it read as an M; bars scale about
// their own centre (fill-box) so the stagger survives the bar↔dot morph.
const BAR_X = [0.27, 11.77, 23.14, 34.37, 45.74, 56.83, 68.2, 79.7];
const BAR_Y = [0.14, 20.3, 34.43, 48.01, 48.01, 34.43, 20.3, 0.14];
const BAR_W = [7.04, 7.17, 7.17, 7.04, 7.04, 7.17, 7.17, 7.04];
const H = [99.59, 79.42, 30.04, 30.18, 30.18, 30.04, 79.42, 99.59];

// Red verdict dot at rest, bottom-right.
const DOT = { x: 92.02, y: 91.69, size: 7.84 };

// The 3 orbit-dots: two cream (currentColor = display) + one red anchor (C).
// Triangle centred on (50,50); the group rotates as a rigid cluster.
const ORBIT = [
  { cx: 50, cy: 28, red: false, pulse: 0 }, // A — top
  { cx: 31, cy: 61, red: false, pulse: 300 }, // B — bottom-left
  { cx: 69, cy: 61, red: true, pulse: 600 }, // C — bottom-right, verdict anchor
];
const ORBIT_R = 9;

type BarVars = React.CSSProperties & {
  "--dot-scale": number;
  "--bar-delay": string;
};

// Split a wordmark string into per-letter spans that pop in on a stagger.
function Letters({
  text,
  base,
  className,
}: {
  text: string;
  base: number;
  className: string;
}) {
  return (
    <span className={className} aria-hidden>
      {text.split("").map((ch, i) => (
        <span
          key={i}
          className="am-ltr"
          style={{ "--letter-delay": `${base + i * 70}ms` } as React.CSSProperties}
        >
          {ch}
        </span>
      ))}
    </span>
  );
}

export function AnimatedMark({
  size = 96,
  mode = "once",
  showWordmark = true,
  className,
}: AnimatedMarkProps) {
  const rootStyle: React.CSSProperties = {
    // Wordmark type scales with the mark; em-based gaps in CSS follow suit.
    fontSize: `${size * 0.2}px`,
  };

  const rootClass = [
    "am-root",
    mode === "loop" ? "am-loop" : "am-once",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={rootClass} style={rootStyle}>
      <div className="am-stage">
        <svg
          className="am-mark"
          width={size}
          height={size}
          viewBox="0 0 100 100"
          aria-hidden
        >
          {/* Bars group — spins + shrinks on dissolve, counter-rotates on
              reassemble. Bars morph bar↔dot via per-bar scaleY. */}
          <g className="am-bars">
            {BAR_X.map((x, i) => {
              const h = H[i];
              const barStyle: BarVars = {
                // scaleY at which the bar (rx=w/2 capsule) reads as a dot.
                "--dot-scale": BAR_W[i] / h,
                "--bar-delay": `${i * 40}ms`,
              };
              return (
                <rect
                  key={i}
                  className="am-bar"
                  x={x}
                  y={BAR_Y[i]}
                  width={BAR_W[i]}
                  height={h}
                  rx={BAR_W[i] / 2}
                  style={barStyle}
                />
              );
            })}
          </g>

          {/* Red verdict rest-dot — sheds on dissolve, lands on reassemble. */}
          <rect
            className="am-dot"
            x={DOT.x}
            y={DOT.y}
            width={DOT.size}
            height={DOT.size}
          />

          {/* Orbit cluster — rotates as a rigid triangle during the swirl. */}
          <g className="am-orbit">
            {ORBIT.map((d, i) => (
              <circle
                key={i}
                className={`am-orbit-dot${d.red ? " am-orbit-dot--red" : ""}`}
                cx={d.cx}
                cy={d.cy}
                r={ORBIT_R}
                style={{ "--pulse-delay": `${d.pulse}ms` } as React.CSSProperties}
              />
            ))}
          </g>
        </svg>

        {showWordmark && (
          <div className="am-lockup" role="img" aria-label="Murmur Verdict">
            <Letters text="MURMUR" base={0} className="am-word" />
            <Letters text=".VERDICT" base={250} className="am-verdict" />
          </div>
        )}
      </div>
    </div>
  );
}
