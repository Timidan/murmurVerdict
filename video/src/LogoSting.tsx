import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from "remotion";
import { loadFont } from "@remotion/google-fonts/SpaceGrotesk";

// Space Grotesk via @remotion/google-fonts. Fetched at render/preview time.
// If it cannot load (offline), the fontFamily below still resolves to the
// system geometric-sans fallback stack declared on the wordmark elements.
const { fontFamily } = loadFont("normal", {
  weights: ["300", "400", "500"],
  subsets: ["latin"],
});
const WORDMARK_STACK = `${fontFamily}, "Space Grotesk", "Futura", "Century Gothic", system-ui, sans-serif`;

// ---------------------------------------------------------------------------
// Design tokens (dark palette per spec v2)
// ---------------------------------------------------------------------------
const BG = "#0A0A0A";
const CREAM = "#FFFFFF"; // bars + cream orbit dots
const RED = "#FD3C3C"; // verdict anchor dot

// ---------------------------------------------------------------------------
// Mark geometry (100x100 viewBox), from MMark.tsx / spec. Bars centered on y=50.
// A bar is a capsule rect (rx = w/2): when height == width it is a CIRCLE, so
// bars <-> dots morph by animating height between BAR_W[i] (dot) and H[i] (bar).
// ---------------------------------------------------------------------------
const BAR_X = [0.27, 11.77, 23.14, 34.37, 45.74, 56.83, 68.2, 79.7];
// BAR_Y = true per-bar vertical positions from MMark.tsx. Bars are NOT centered
// on y=50 — this stagger is what makes the mark read as an "M" (not a symmetric
// soundbar). Each bar grows about its OWN center: y = BAR_Y[i] + (H[i] - h) / 2.
const BAR_Y = [0.14, 20.3, 34.43, 48.01, 48.01, 34.43, 20.3, 0.14];
const BAR_W = [7.04, 7.17, 7.17, 7.04, 7.04, 7.17, 7.17, 7.04];
const H = [99.59, 79.42, 30.04, 30.18, 30.18, 30.04, 79.42, 99.59];

// Red verdict dot final rest: square at bottom-right of the mark.
const DOT_REST = { x: 92.02, y: 91.69, size: 7.84 };
const DOT_REST_CX = DOT_REST.x + DOT_REST.size / 2; // 95.94
const DOT_REST_CY = DOT_REST.y + DOT_REST.size / 2; // 95.61

// ---------------------------------------------------------------------------
// The 3 orbit-dots (about center 50,50). Equilateral triangle at radius 22.
//   A cream (50,28) top      -> angle -90deg
//   B cream (31,61) bot-left  -> angle 150deg
//   C RED   (69,61) bot-right -> angle  30deg  (becomes the verdict dot)
// ---------------------------------------------------------------------------
const CENTER = 50;
const ORBIT_R = 22; // triangle radius
const ORBIT_DOT_R = 9; // ball radius
const ANGLE_A = -Math.PI / 2;
const ANGLE_B = (5 * Math.PI) / 6;
const ANGLE_C = Math.PI / 6;
const SWIRL_TURN = (450 * Math.PI) / 180; // 1.25 turns, clearly visible

function orbitPoint(base: number, r: number, theta: number) {
  return {
    x: CENTER + r * Math.cos(base + theta),
    y: CENTER + r * Math.sin(base + theta),
  };
}
// Red dot's position at the instant the swirl ends (start of its flight home).
const RED_AT_CONVERGE = orbitPoint(ANGLE_C, ORBIT_R, SWIRL_TURN);

// ---------------------------------------------------------------------------
// Beat map (frames @30fps, "once" reveal, ends on the assembled lockup).
//   RESPAWN  0–9    3 dots scale in at center into the triangle
//   SWIRL    9–54   rotate the 3-dot cluster ~450deg, dots pulse (HERO)
//   CONVERGE 54–84  dots -> center + fade; bars grow from center (dot->bar),
//                   bars group rotates slight-angle -> upright; red dot flies
//                   to its bottom-right rest.
//   SLIDE    76–90  assembled mark eases left into the horizontal lockup slot
//   WORDMARK 90–120 MURMUR then .VERDICT letters pop in L->R (per-letter)
//   HOLD     122–135 assembled lockup holds (bars breathe)
// ---------------------------------------------------------------------------
const RESPAWN_END = 9;
const SWIRL_START = 9;
const SWIRL_END = 54;
const CONVERGE_START = 54;
const RED_FLIGHT_END = 80;
const BARS_ROT_END = 82;
const SLIDE_START = 76;
const SLIDE_END = 90;
const WORD_START = 90;
const HOLD_START = 122;

const easeOut = Easing.bezier(0.25, 0.1, 0.25, 1);
const easeInOut = Easing.inOut(Easing.cubic);

const clamp = {
  extrapolateLeft: "clamp",
  extrapolateRight: "clamp",
} as const;

// Frame layout (1920x1080). WORDMARK_W is an estimate of the rendered
// MURMUR.VERDICT width; it only affects horizontal centering of the lockup.
const FRAME_W = 1920;
const FRAME_H = 1080;
const MARK_PX = 240;
const GAP_PX = 40;
const WORDMARK_W = 1080;
const TOTAL_W = MARK_PX + GAP_PX + WORDMARK_W;
const LOCKUP_LEFT = (FRAME_W - TOTAL_W) / 2;
const MARK_LOCKUP_CX = LOCKUP_LEFT + MARK_PX / 2;
const WORDMARK_LEFT = LOCKUP_LEFT + MARK_PX + GAP_PX;

const MURMUR = "MURMUR".split("");
const VERDICT = ".VERDICT".split("");

/** One wordmark letter: translateY(8->0) + opacity(0->1) popping in. */
const Letter: React.FC<{ ch: string; start: number; frame: number }> = ({
  ch,
  start,
  frame,
}) => {
  const opacity = interpolate(frame, [start, start + 6], [0, 1], clamp);
  const ty = interpolate(frame, [start, start + 6], [8, 0], {
    ...clamp,
    easing: easeOut,
  });
  return (
    <span
      style={{
        display: "inline-block",
        opacity,
        transform: `translateY(${ty}px)`,
      }}
    >
      {ch}
    </span>
  );
};

/** height of bar i at frame: BAR_W[i] (dot) grows to H[i], staggered L->R. */
function barHeight(i: number, frame: number): number {
  if (frame <= CONVERGE_START) return BAR_W[i];
  const start = 55 + i * 1.5;
  return interpolate(frame, [start, start + 16], [BAR_W[i], H[i]], {
    ...clamp,
    easing: easeOut,
  });
}

export const LogoSting: React.FC = () => {
  const frame = useCurrentFrame();

  // ---- Swirl rotation & orbit radius -------------------------------------
  const theta = interpolate(frame, [SWIRL_START, SWIRL_END], [0, SWIRL_TURN], {
    ...clamp,
    easing: easeInOut,
  });
  // Cream cluster radius: grow in (respawn), hold (swirl), collapse (converge).
  const creamR = interpolate(
    frame,
    [0, RESPAWN_END, CONVERGE_START, CONVERGE_START + 14],
    [0, ORBIT_R, ORBIT_R, 0],
    { ...clamp, easing: easeOut },
  );
  const creamOpacity = interpolate(
    frame,
    [0, RESPAWN_END, CONVERGE_START, CONVERGE_START + 14],
    [0, 1, 1, 0],
    clamp,
  );
  const inSwirl = frame >= SWIRL_START && frame <= SWIRL_END;
  const pulse = (phase: number) =>
    inSwirl ? 1 + 0.18 * Math.sin((frame - SWIRL_START) * 0.6 + phase) : 1;

  const posA = orbitPoint(ANGLE_A, creamR, theta);
  const posB = orbitPoint(ANGLE_B, creamR, theta);
  const rA = ORBIT_DOT_R * pulse(0);
  const rB = ORBIT_DOT_R * pulse(Math.PI);

  // ---- Red verdict dot ----------------------------------------------------
  // Respawn/swirl: orbits with the cluster (circle). Converge: flies to the
  // bottom-right rest while morphing circle -> square (rx 9 -> 0).
  const redOrbitR = interpolate(frame, [0, RESPAWN_END], [0, ORBIT_R], {
    ...clamp,
    easing: easeOut,
  });
  const redOrbit = orbitPoint(ANGLE_C, redOrbitR, theta);
  const redCx =
    frame <= CONVERGE_START
      ? redOrbit.x
      : interpolate(frame, [CONVERGE_START, RED_FLIGHT_END], [RED_AT_CONVERGE.x, DOT_REST_CX], {
          ...clamp,
          easing: easeOut,
        });
  const redCy =
    frame <= CONVERGE_START
      ? redOrbit.y
      : interpolate(frame, [CONVERGE_START, RED_FLIGHT_END], [RED_AT_CONVERGE.y, DOT_REST_CY], {
          ...clamp,
          easing: easeOut,
        });
  const redSize = interpolate(
    frame,
    [0, RESPAWN_END, CONVERGE_START, RED_FLIGHT_END],
    [0, ORBIT_DOT_R * 2, ORBIT_DOT_R * 2, DOT_REST.size],
    { ...clamp, easing: easeOut },
  );
  const redRx = interpolate(
    frame,
    [0, RESPAWN_END, CONVERGE_START, RED_FLIGHT_END],
    [0, ORBIT_DOT_R, ORBIT_DOT_R, 0],
    { ...clamp, easing: easeOut },
  );
  const redOpacity = interpolate(frame, [0, RESPAWN_END], [0, 1], clamp);

  // ---- Bars ---------------------------------------------------------------
  const barsRot = interpolate(frame, [CONVERGE_START, BARS_ROT_END], [-14, 0], {
    ...clamp,
    easing: easeOut,
  });
  let barsOpacity = interpolate(frame, [CONVERGE_START, CONVERGE_START + 8], [0, 1], clamp);
  if (frame >= HOLD_START) {
    // subtle breathe during hold
    barsOpacity = 0.925 + 0.075 * Math.cos(((frame - HOLD_START) / 13) * Math.PI * 2);
  }

  // ---- Mark slide into the horizontal lockup slot -------------------------
  const markCx = interpolate(frame, [SLIDE_START, SLIDE_END], [FRAME_W / 2, MARK_LOCKUP_CX], {
    ...clamp,
    easing: easeOut,
  });

  return (
    <AbsoluteFill style={{ backgroundColor: BG }}>
      {/* Mark (SVG): orbit dots -> waveform bars + red verdict dot */}
      <div
        style={{
          position: "absolute",
          width: MARK_PX,
          height: MARK_PX,
          left: markCx - MARK_PX / 2,
          top: FRAME_H / 2 - MARK_PX / 2,
        }}
      >
        <svg
          width={MARK_PX}
          height={MARK_PX}
          viewBox="0 0 100 100"
          style={{ overflow: "visible", display: "block" }}
          aria-hidden
        >
          {/* Waveform bars (dots -> bars), group tilts upright */}
          <g
            transform={`rotate(${barsRot} ${CENTER} ${CENTER})`}
            opacity={barsOpacity}
          >
            {BAR_X.map((x, i) => {
              const h = barHeight(i, frame);
              return (
                <rect
                  key={i}
                  x={x}
                  y={BAR_Y[i] + (H[i] - h) / 2}
                  width={BAR_W[i]}
                  height={Math.max(h, 0)}
                  rx={BAR_W[i] / 2}
                  fill={CREAM}
                />
              );
            })}
          </g>

          {/* Two cream orbit dots */}
          <circle cx={posA.x} cy={posA.y} r={rA} fill={CREAM} opacity={creamOpacity} />
          <circle cx={posB.x} cy={posB.y} r={rB} fill={CREAM} opacity={creamOpacity} />

          {/* Red anchor: orbit dot -> verdict square */}
          <rect
            x={redCx - redSize / 2}
            y={redCy - redSize / 2}
            width={redSize}
            height={redSize}
            rx={redRx}
            fill={RED}
            opacity={redOpacity}
          />
        </svg>
      </div>

      {/* Wordmark: MURMUR + .VERDICT on one baseline, letters pop in L->R */}
      <div
        style={{
          position: "absolute",
          left: WORDMARK_LEFT,
          top: FRAME_H / 2,
          transform: "translateY(-50%)",
          whiteSpace: "nowrap",
        }}
      >
        <span
          style={{
            display: "inline-block",
            verticalAlign: "baseline",
            fontFamily: WORDMARK_STACK,
            fontWeight: 300,
            fontSize: 132,
            letterSpacing: "0.12em",
            color: CREAM,
            lineHeight: 1,
          }}
        >
          {MURMUR.map((ch, i) => (
            <Letter key={i} ch={ch} start={WORD_START + i * 2} frame={frame} />
          ))}
        </span>
        <span
          style={{
            display: "inline-block",
            verticalAlign: "baseline",
            fontFamily: WORDMARK_STACK,
            fontWeight: 400,
            fontSize: 82,
            letterSpacing: "0.14em",
            color: "rgba(255,255,255,0.55)",
            lineHeight: 1,
          }}
        >
          {VERDICT.map((ch, j) => (
            <Letter
              key={j}
              ch={ch}
              start={WORD_START + (MURMUR.length + j) * 2}
              frame={frame}
            />
          ))}
        </span>
      </div>
    </AbsoluteFill>
  );
};
