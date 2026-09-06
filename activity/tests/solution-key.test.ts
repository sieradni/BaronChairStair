/**
 * When two solutions are the same solution, and what the store does about it.
 *
 * The equivalence rule is the whole feature: too strict and every rotation of an
 * O piece is a fresh discovery, so the leaderboard is a farm; too loose and the
 * second player to find something genuinely new is told it is already known.
 *
 * The archive is the oracle. Puzzle 15's goal text says "Clear 1 TSD (2
 * solutions)" and puzzle 46's author recorded one — numbers written by a person,
 * years before any of this, that a canonical form either agrees with or does not.
 */

import { describe, expect, test } from "bun:test";
import type { ClearName, SolutionStep } from "../shared/puzzle";
import { SOLUTION_KEY_VERSION, solutionFingerprint, solutionKey } from "../shared/solution-key";

const step = (
  piece: SolutionStep["piece"],
  cells: [number, number][],
  clear: ClearName | null = null,
  attack = 0,
): SolutionStep => ({ piece, cells, clear, attack });

const T_SPIN = step("T", [[3, 0], [4, 0], [5, 0], [4, 1]], "tsd", 4);
const I_FLAT = step("I", [[0, 1], [1, 1], [2, 1], [3, 1]]);

describe("what counts as the same solution", () => {
  test("the order the pieces were placed in does not matter", () => {
    // Same seats, same results, different sequence. One solution.
    expect(solutionKey([T_SPIN, I_FLAT])).toBe(solutionKey([I_FLAT, T_SPIN]));
  });

  test("nor does the order the cells happen to be written in", () => {
    const jumbled = step("T", [[4, 1], [5, 0], [3, 0], [4, 0]], "tsd", 4);
    expect(solutionKey([jumbled])).toBe(solutionKey([T_SPIN]));
  });

  test("but the clear a placement earned does", () => {
    // The same four squares reached by a different kick. Measured on the real
    // archive: 5 of 138 puzzles produce a different clear AND attack from
    // identical cells, and one of the two may not be a solve at all.
    const mini = step("T", [[3, 0], [4, 0], [5, 0], [4, 1]], "tsmini", 1);
    expect(solutionKey([mini])).not.toBe(solutionKey([T_SPIN]));
  });

  test("and so does which piece went there", () => {
    const asS = step("S", [[3, 0], [4, 0], [5, 0], [4, 1]], "tsd", 4);
    expect(solutionKey([asS])).not.toBe(solutionKey([T_SPIN]));
  });

  test("a different seat is a different solution", () => {
    const moved = step("T", [[4, 0], [5, 0], [6, 0], [5, 1]], "tsd", 4);
    expect(solutionKey([moved])).not.toBe(solutionKey([T_SPIN]));
  });
});

describe("the fingerprint the store is keyed on", () => {
  test("carries the run's own totals, which the parts do not", () => {
    // A combo or back-to-back bonus is scored against the sequence, not against
    // any one placement — so two orderings can share every placement and still
    // have sent different garbage. Same set, different result, different row.
    const one = solutionFingerprint([T_SPIN, I_FLAT], { attack: 4, clears: ["tsd"] });
    const two = solutionFingerprint([I_FLAT, T_SPIN], { attack: 6, clears: ["tsd"] });
    expect(one).not.toBe(two);
  });

  test("is stable when only the order changes", () => {
    const one = solutionFingerprint([T_SPIN, I_FLAT], { attack: 4, clears: ["tsd"] });
    const two = solutionFingerprint([I_FLAT, T_SPIN], { attack: 4, clears: ["tsd"] });
    expect(one).toBe(two);
  });

  test("names the version it was made under", () => {
    // A changed rule must not silently re-credit or un-credit anybody, so every
    // row records which rule made it.
    expect(solutionFingerprint([T_SPIN], { attack: 4, clears: ["tsd"] }))
      .toStartWith(`v${SOLUTION_KEY_VERSION}|`);
  });
});
