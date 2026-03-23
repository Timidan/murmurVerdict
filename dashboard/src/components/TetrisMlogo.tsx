import { useRef, useEffect } from "react";

/**
 * Full MURMUR pixel-block logo rendered on canvas.
 * The M icon uses the larger grid (pink top / cyan bottom).
 * The "URMUR" letters are rendered as purple pixel blocks.
 * Everything is one cohesive pixel-art piece.
 */

// ── Letter grids (5 cols x 7 rows each) ─────────────────────────
const U = [
  [1,0,0,0,1],
  [1,0,0,0,1],
  [1,0,0,0,1],
  [1,0,0,0,1],
  [1,0,0,0,1],
  [1,0,0,0,1],
  [1,1,1,1,1],
];

const R = [
  [1,1,1,1,0],
  [1,0,0,0,1],
  [1,0,0,0,1],
  [1,1,1,1,0],
  [1,0,0,1,0],
  [1,0,0,0,1],
  [1,0,0,0,1],
];

// M icon grid — 9 cols x 7 rows (larger, distinctive)
const M_ICON = [
  [1,1,0,0,0,0,0,1,1],
  [1,1,1,0,0,0,1,1,1],
  [1,1,1,1,0,1,1,1,1],
  [1,1,0,1,1,1,0,1,1],
  [1,1,0,0,1,0,0,1,1],
  [1,1,0,0,0,0,0,1,1],
  [1,1,0,0,0,0,0,1,1],
];

const PINK = "#f472b6";
const CYAN = "#67e8f9";
const PURPLE = "#a78bfa";
const PURPLE_DIM = "#6d28d9";
const PINK_DIM = "#a8315e";
const CYAN_DIM = "#1a7f8f";

interface MurmurPixelLogoProps {
  /** Height of the logo in pixels */
  height?: number;
}

export function TetrisMlogo({ height = 140 }: MurmurPixelLogoProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Calculate cell size from desired height (7 rows)
  const cellSize = Math.floor(height / 7);
  const gap = 2; // gap between letters in cells

  // Total width: M_ICON(9) + gap + U(5) + gap + R(5) + gap + M_ICON(but as letter M, 5) + gap + U(5) + gap + R(5)
  // Actually let's use a simpler M letter for the text part
  const M_LETTER: number[][] = [
    [1,0,0,0,1],
    [1,1,0,1,1],
    [1,0,1,0,1],
    [1,0,1,0,1],
    [1,0,0,0,1],
    [1,0,0,0,1],
    [1,0,0,0,1],
  ];

  // Layout: M_ICON (9 cols) + gap + U(5) + R(5) + M(5) + U(5) + R(5) with 1-col gaps
  const letters = [U, R, M_LETTER, U, R];
  const letterGap = 1;
  const iconTextGap = 2;

  const totalCols = 9 + iconTextGap + letters.length * 5 + (letters.length - 1) * letterGap;
  const totalRows = 7;

  const canvasW = cellSize * totalCols;
  const canvasH = cellSize * totalRows;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvasW * dpr;
    canvas.height = canvasH * dpr;
    ctx.scale(dpr, dpr);

    // Glow pass
    ctx.save();
    ctx.filter = "blur(8px)";
    drawAll(ctx, cellSize, iconTextGap, letterGap);
    ctx.restore();

    // Sharp pass
    drawAll(ctx, cellSize, iconTextGap, letterGap);
  }, [canvasW, canvasH, cellSize, iconTextGap, letterGap]);

  function drawAll(ctx: CanvasRenderingContext2D, cs: number, itGap: number, lGap: number) {
    // Draw M icon
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 9; c++) {
        if (M_ICON[r][c]) {
          const color = r < 3 ? PINK : CYAN;
          const border = r < 3 ? PINK_DIM : CYAN_DIM;
          drawBlock(ctx, c, r, cs, color, border);
        }
      }
    }

    // Draw URMUR letters in purple
    let xOffset = 9 + itGap;
    for (let li = 0; li < letters.length; li++) {
      const letter = letters[li];
      for (let r = 0; r < 7; r++) {
        for (let c = 0; c < 5; c++) {
          if (letter[r][c]) {
            drawBlock(ctx, xOffset + c, r, cs, PURPLE, PURPLE_DIM);
          }
        }
      }
      xOffset += 5 + lGap;
    }
  }

  return (
    <canvas
      ref={canvasRef}
      style={{ width: canvasW, height: canvasH, display: "block" }}
    />
  );
}

function drawBlock(
  ctx: CanvasRenderingContext2D,
  col: number,
  row: number,
  size: number,
  color: string,
  border: string,
) {
  const x = col * size;
  const y = row * size;
  const g = 1;
  const s = size - g * 2;

  ctx.fillStyle = color;
  ctx.fillRect(x + g, y + g, s, s);

  // Highlight top-left
  ctx.fillStyle = "rgba(255,255,255,0.12)";
  ctx.fillRect(x + g, y + g, s, 2);
  ctx.fillRect(x + g, y + g, 2, s);

  // Shadow bottom-right
  ctx.fillStyle = "rgba(0,0,0,0.25)";
  ctx.fillRect(x + g, y + g + s - 2, s, 2);
  ctx.fillRect(x + g + s - 2, y + g, 2, s);
}
