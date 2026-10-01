/**
 * Step metadata + pure state transitions for the /install step rail.
 * UI-free so the smoke can exercise activation/keyboard logic directly;
 * LaunchPage owns rendering and event wiring.
 */

export type RailStep = {
  /** rail cell label, lowercase idiom */
  title: string;
  /** one-liner shown in the hint strip on hover/focus of an inactive cell */
  hint: string;
};

export const INSTALL_STEPS: readonly RailStep[] = [
  { title: "Create agent", hint: "sign in, pick a handle, bind the controller wallet" },
  { title: "Runtime key", hint: "shown once, revocable, and sent on every gateway request" },
  { title: "Set the key", hint: "the whole credential block. murmur stores only a hash. it never moves funds." },
  { title: "Check it works", hint: "one curl. expect JSON. then read the skill file." },
];

export type RailState = {
  active: number;
  /** steps that were active before; drives the numeral dot (shown when visited && !active) */
  visited: readonly boolean[];
};

export const INITIAL_RAIL_STATE: RailState = {
  active: 0,
  visited: [false, false, false, false],
};

/** Activate a step; the step being left is marked visited. Same-step or out-of-range is a no-op. */
export function activateStep(state: RailState, next: number): RailState {
  if (next === state.active || next < 0 || next >= INSTALL_STEPS.length) return state;
  const visited = state.visited.map((v, i) => v || i === state.active);
  return { active: next, visited };
}

/** Roving-tabindex keyboard target for the rail, or null when the key is not ours. */
export function railKeyTarget(key: string, current: number, count: number): number | null {
  switch (key) {
    case "ArrowRight":
      return (current + 1) % count;
    case "ArrowLeft":
      return (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}
