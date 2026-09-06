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

  test("nor which of the placements happened to earn the clear", () => {
    // Whichever piece finishes the board is the one credited with the line, and
    // that is decided by the order, not by the answer. Fill two wells: go left
    // first and the right-hand piece scores; go right first and the left-hand
    // one does. Same board, same pieces, same seats — one solution, and keying
    // on the attribution made it two.
    const scored = step("I", [[0, 0], [0, 1], [0, 2], [0, 3]], "quad", 4);
    const quiet = step("I", [[0, 0], [0, 1], [0, 2], [0, 3]]);
    expect(solutionKey([scored])).toBe(solutionKey([quiet]));
  });

  test("the clear is asked at the level it cannot be shuffled at", () => {
    // Not lost, moved: the same four squares reached by a different kick really
    // are a different result — measured on the archive, 5 of 138 puzzles
    // produce a different clear AND attack from identical cells, and one of the
    // two may not be a solve at all. The run's totals say so, and unlike the
    // per-placement credit they do not move when the order does.
    const asMini = solutionFingerprint([T_SPIN], { attack: 1, clears: ["tsmini"] });
    const asFull = solutionFingerprint([T_SPIN], { attack: 4, clears: ["tsd"] });
    expect(asMini).not.toBe(asFull);
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
