/**
 * Which tier a puzzle lands in, stated in the units the club actually uses.
 *
 * The archive rates a puzzle 1-to-10-and-beyond, but a player is shown *squares*
 * — `difficultyPips` fills one per two rating points, capped at five. The tiers
 * are defined in squares because that is what the club decided in those terms:
 * easy is at most one square, medium is two, hard is three or four, extreme is
 * five and above.
 *
 * So the arithmetic lives in one place, `difficultySquares`, and both the bands
 * and the pips read it. Written as two constants in two files it would drift,
 * and the failure would be quiet: a puzzle showing three squares while being
 * dealt as the day's easy one.
 *
 * **Unrated stays hard.** A puzzle rated 0 fills no squares, so "at most one
 * square" would sweep it into easy — but it is rated nothing because nobody got
 * round to it, not because it is gentle, and the archive's unrated puzzles ask
 * for things like "2 TSS, 3 TSD" over a dozen pieces. That rule predates this
 * change and is deliberately kept.
 */

import { describe, expect, test } from "bun:test";
import { dailyTierOf, DAILY_TIERS, byTier } from "../shared/daily";
import { difficultySquares } from "../shared/puzzle";

const at = (difficulty: number) => dailyTierOf({ difficulty });

describe("difficultySquares", () => {
  test("fills one square per two rating points", () => {
    expect([1, 2, 3, 4, 5, 6].map(difficultySquares)).toEqual([1, 1, 2, 2, 3, 3]);
  });

  test("caps at five, however high the rating goes", () => {
    // The archive runs to 20, so this band is real puzzles rather than theory.
    expect(difficultySquares(9)).toBe(5);
    expect(difficultySquares(10)).toBe(5);
    expect(difficultySquares(20)).toBe(5);
  });

  test("an unrated puzzle fills none", () => {
    expect(difficultySquares(0)).toBe(0);
  });
});

describe("dailyTierOf", () => {
  test("easy is at most one square", () => {
    expect([at(1), at(2)]).toEqual(["easy", "easy"]);
  });

  test("medium is two squares", () => {
    expect([at(3), at(4)]).toEqual(["medium", "medium"]);
  });

  test("hard is three or four squares", () => {
    expect([at(5), at(6), at(7), at(8)]).toEqual(["hard", "hard", "hard", "hard"]);
  });

  test("extreme is five squares and above", () => {
    expect([at(9), at(10), at(15), at(20)]).toEqual(["extreme", "extreme", "extreme", "extreme"]);
  });

  test("an unrated puzzle is hard, not easy", () => {
    expect(at(0)).toBe("hard");
    expect(at(-1)).toBe("hard");
  });

  test("every tier is reachable, so no tier can be dealt from an empty pool", () => {
    const reached = new Set([...Array(21).keys()].map((d) => at(d)));
    expect([...reached].sort()).toEqual([...DAILY_TIERS].sort());
  });

  test("the bands agree with the squares a player is shown", () => {
    // The invariant this file exists for. If somebody retunes one, this fails.
    for (let d = 1; d <= 20; d += 1) {
      const squares = difficultySquares(d);
      const expected =
        squares <= 1 ? "easy" : squares === 2 ? "medium" : squares <= 4 ? "hard" : "extreme";
      expect(at(d)).toBe(expected);
    }
  });
});

describe("byTier", () => {
  test("splits into all four tiers and loses nothing", () => {
    const puzzles = [1, 3, 5, 9, 0].map((difficulty) => ({ difficulty }));

    const split = byTier(puzzles);

    expect(Object.keys(split).sort()).toEqual([...DAILY_TIERS].sort());
    expect(DAILY_TIERS.reduce((n, tier) => n + split[tier].length, 0)).toBe(puzzles.length);
    expect(split.extreme).toHaveLength(1);
  });
});
