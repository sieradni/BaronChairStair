/**
 * The three modes the goal rule can be in, and what each of them decides.
 *
 * This is the whole point of the feature and, until this file, nothing
 * exercised it: `grep -rn GOAL_ENFORCEMENT tests/` found one hit, and it was a
 * comment. `solvedUnderPolicy` takes its mode as a parameter precisely so it
 * can be asked directly, without a server, an env var, or the import-order
 * hazard that reading `config` at module scope brings with it.
 *
 * The case that matters is the one in the middle: a run that reaches the attack
 * target *without* the clears the goal names. Under `off` it is a solve, under
 * `log` it is a solve and a warning, under `on` it is not a solve. Everything
 * else in this feature is machinery for getting that one decision right.
 */

import { describe, expect, mock, test } from "bun:test";
import { solvedUnderPolicy } from "../server/solve-verdict";
import type { ClearName, Puzzle } from "../shared/puzzle";

/** A puzzle worth 4 attack that also insists on a TSD. */
const DEMANDS_A_TSD = {
  id: 7,
  goal: "Clear a TSD",
  targetAttack: 4,
  requiredClears: [{ clear: "tsd" as const, count: 1 }],
} as unknown as Puzzle;

/** The run at the heart of it: the number reached, the clear never made. */
const QUAD_ONLY: readonly ClearName[] = ["quad"];
const THE_TSD: readonly ClearName[] = ["tsd"];

function quietly<T>(run: () => T): { readonly value: T; readonly warnings: number } {
  const warn = console.warn;
  let warnings = 0;
  console.warn = mock(() => void warnings++);
  try {
    return { value: run(), warnings };
  } finally {
    console.warn = warn;
  }
}

describe("what each enforcement mode decides", () => {
  test("off: the attack target is the whole condition, as it was before", () => {
    const { value, warnings } = quietly(() =>
      solvedUnderPolicy(4, QUAD_ONLY, DEMANDS_A_TSD, "test", "off"),
    );

    expect(value).toBe(true);
    // Not even a line: `off` is the pre-feature behaviour, and a server run
    // that way should not be narrating a rule it is not applying.
    expect(warnings).toBe(0);
  });

  test("log: still a solve, but the disagreement is said out loud", () => {
    // The shipped default, and the reason merging this is safe: nothing a
    // player experiences changes, and the officers get the evidence they need
    // to decide whether `on` is safe.
    const { value, warnings } = quietly(() =>
      solvedUnderPolicy(4, QUAD_ONLY, DEMANDS_A_TSD, "test", "log"),
    );

    expect(value).toBe(true);
    expect(warnings).toBe(1);
  });

  test("on: the goal is the condition, and the quad-only run is refused", () => {
    const { value, warnings } = quietly(() =>
      solvedUnderPolicy(4, QUAD_ONLY, DEMANDS_A_TSD, "test", "on"),
    );

    expect(value).toBe(false);
    expect(warnings).toBe(1);
  });

  test("a run that does what the goal says is a solve in every mode", () => {
    for (const mode of ["off", "log", "on"] as const) {
      const { value, warnings } = quietly(() =>
        solvedUnderPolicy(4, THE_TSD, DEMANDS_A_TSD, "test", mode),
      );
      expect(value, `mode ${mode}`).toBe(true);
      // No disagreement, so nothing to report — a log that fires on the
      // ordinary case is a log nobody reads.
      expect(warnings, `mode ${mode}`).toBe(0);
    }
  });

  test("missing the attack target is a miss in every mode, and is not news", () => {
    for (const mode of ["off", "log", "on"] as const) {
      const { value, warnings } = quietly(() =>
        solvedUnderPolicy(2, THE_TSD, DEMANDS_A_TSD, "test", mode),
      );
      expect(value, `mode ${mode}`).toBe(false);
      expect(warnings, `mode ${mode}`).toBe(0);
    }
  });

  test("a puzzle demanding nothing behaves identically in all three", () => {
    // The 26 puzzles whose goal names nothing a count can hold, and every
    // puzzle at all until the backfill ran. Turning enforcement on must not
    // change what any of them decide.
    const plain = { ...DEMANDS_A_TSD, requiredClears: [] } as unknown as Puzzle;
    const verdicts = (["off", "log", "on"] as const).map(
      (mode) => quietly(() => solvedUnderPolicy(4, QUAD_ONLY, plain, "test", mode)).value,
    );

    expect(verdicts).toEqual([true, true, true]);
  });
});
