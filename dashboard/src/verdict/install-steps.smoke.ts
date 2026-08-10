import assert from "node:assert/strict";

import {
  INSTALL_STEPS,
  INITIAL_RAIL_STATE,
  activateStep,
  railKeyTarget,
} from "./install-steps.js";

// Four steps, each fully labeled for rail + hint strip.
assert.equal(INSTALL_STEPS.length, 4);
for (const step of INSTALL_STEPS) {
  assert.ok(step.title.length > 0);
  assert.ok(step.hint.length > 0);
}

// Activation marks the step being LEFT as visited, not the destination.
let s = activateStep(INITIAL_RAIL_STATE, 2);
assert.equal(s.active, 2);
assert.deepEqual([...s.visited], [true, false, false, false]);

// Same-step activation is a no-op (clicking the active cell adds no dot).
assert.equal(activateStep(s, 2), s);

// Out-of-range activation is a no-op.
assert.equal(activateStep(s, 4), s);
assert.equal(activateStep(s, -1), s);

// Walking 2 → 1 → 3 accumulates visited flags for 0, 2, then 1.
s = activateStep(s, 1);
assert.deepEqual([...s.visited], [true, false, true, false]);
s = activateStep(s, 3);
assert.deepEqual([...s.visited], [true, true, true, false]);

// The walk above must not have mutated the exported initial state: a mutating
// activateStep would corrupt the module singleton every mount reads.
assert.deepEqual([...INITIAL_RAIL_STATE.visited], [false, false, false, false]);
assert.equal(INITIAL_RAIL_STATE.active, 0);

// Keyboard: arrows wrap, Home/End jump, other keys are not ours.
assert.equal(railKeyTarget("ArrowRight", 3, 4), 0);
assert.equal(railKeyTarget("ArrowRight", 1, 4), 2);
assert.equal(railKeyTarget("ArrowLeft", 0, 4), 3);
assert.equal(railKeyTarget("Home", 2, 4), 0);
assert.equal(railKeyTarget("End", 0, 4), 3);
assert.equal(railKeyTarget("Enter", 1, 4), null);
assert.equal(railKeyTarget("a", 1, 4), null);

console.log("install-steps.smoke: ok");
