// Resolution-order checks for resolveTheme({ stored, prefersLight }).
// Run: tsx dashboard/src/verdict/ui/theme.smoke.ts

import { resolveTheme } from "./theme.js";

const cases: Array<[Parameters<typeof resolveTheme>[0], "dark" | "paper", string]> = [
  [{ stored: "paper", prefersLight: false }, "paper", "stored paper wins over system"],
  [{ stored: "dark", prefersLight: true }, "dark", "stored dark wins over system"],
  [{ stored: null, prefersLight: true }, "paper", "system light fills in when no stored"],
  [{ stored: null, prefersLight: false }, "dark", "system dark fills in when no stored"],
  [{ stored: "garbage" as any, prefersLight: false }, "dark", "invalid stored falls back to dark"],
  [{ stored: "garbage" as any, prefersLight: true }, "paper", "invalid stored still respects system"],
];

let failed = 0;
for (const [input, expected, label] of cases) {
  const got = resolveTheme(input);
  if (got !== expected) {
    console.error(`FAIL  ${label}\n        input=${JSON.stringify(input)}\n        want=${expected}\n        got=${got}`);
    failed++;
  } else {
    console.log(`PASS  ${label}`);
  }
}
if (failed) {
  console.error(`\n${failed} failure(s).`);
  process.exit(1);
}
console.log(`\nAll ${cases.length} theme-resolution cases passed.`);
