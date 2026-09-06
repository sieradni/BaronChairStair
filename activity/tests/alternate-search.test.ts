/**
 * The search that answers "is this the only way?".
 *
 * Its two readers want opposite reassurances. A maker wants to be told their
 * condition is tight, which only an exhausted search may say. A player wants
 * credit for a line nobody recorded, which only holds if the search would have
 * found that line had it looked. Both fail the same way — a placement the
 * search cannot reach — so the tests that matter here are the ones that pin
 * what it can reach and what it is allowed to claim.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_LIMITS, searchSolutions } from "../shared/tetris/enumerate";
import { DEFAULT_HANDLING } from "../shared/tetris/handling";
import { replayPlacements } from "../shared/tetris/replay";
import { decodeBoard, ENGINE_ROWS } from "../shared/puzzle";
import { solutionKey } from "../shared/solution-key";
import type { Puzzle } from "../shared/puzzle";

const GENEROUS = { maxLines: 200, maxNodes: 200_000, maxMillis: 30_000 };

function puzzleOf(fields: Partial<Puzzle>): Puzzle {
  return {
    id: 1,
    title: "test",
    author: "test",
    difficulty: 1,
    goal: "test",
    set: null,
    board: [],
    queue: ["I"],
    hold: null,
    targetAttack: 1,
    ...fields,
  };
}

/**
 * A well: four rows filled but for column zero, so one vertical I fills all
 * four at once. A quad, because a single clear sends nothing at all in this
 * ruleset and a puzzle scored on attack would never register it.
 */
const WELL = [".GGGGGGGGG", ".GGGGGGGGG", ".GGGGGGGGG", ".GGGGGGGGG"];
const QUAD_WELL = puzzleOf({ board: WELL, queue: ["I"], targetAttack: 4 });

describe("finding every way a puzzle can be solved", () => {
  test("the obvious line is found, and the search knows it looked everywhere", () => {
    const report = searchSolutions(QUAD_WELL, GENEROUS);

    expect(report.stoppedBy).toBe("exhausted");
    expect(report.lines.length).toBeGreaterThan(0);
    // Every line it returns really does clear the row it was asked to clear.
    for (const line of report.lines) {
      expect(line.attack).toBeGreaterThanOrEqual(QUAD_WELL.targetAttack);
      expect(line.clears.length).toBeGreaterThan(0);
    }
  });

  test("a line stops at the placement that solves it, because the run would", () => {
    // Two pieces, but the first one already finishes the row. The second is
    // never placed — the game ends the run on the solve, so a line carrying a
    // piece after it is a line nobody could have played.
    const report = searchSolutions(
      puzzleOf({ board: WELL, queue: ["I", "O"], targetAttack: 4 }),
      GENEROUS,
    );

    expect(report.lines.length).toBeGreaterThan(0);
    const shortest = Math.min(...report.lines.map((line) => line.placements.length));
    expect(shortest).toBe(1);
  });

  test("a required clear the line never made is not a solve", () => {
    // The board and pieces are unchanged; only the demand is. Asking for a TSD
    // from a board with no T-slot and no T piece must find nothing at all,
    // where asking for the attack alone finds plenty.
    const onAttack = searchSolutions(QUAD_WELL, GENEROUS);
    const onClears = searchSolutions(
      puzzleOf({
        board: WELL,
        queue: ["I"],
        targetAttack: 4,
        requiredClears: [{ clear: "tsd", count: 1 }],
      }),
      GENEROUS,
    );

    expect(onAttack.lines.length).toBeGreaterThan(0);
    expect(onClears.lines).toEqual([]);
    expect(onClears.stoppedBy).toBe("exhausted");
  });

  test("two orders of the same placements are one solution", () => {
    // A board needing two separate columns filled: the pieces can go down in
    // either order and it is the same answer, which is the rule the leaderboard
    // pays out on.
    const report = searchSolutions(
      puzzleOf({
        board: [".GGGGGGGG.", ".GGGGGGGG.", ".GGGGGGGG.", ".GGGGGGGG."],
        queue: ["I", "I"],
        targetAttack: 4,
      }),
      GENEROUS,
    );

    const keys = report.lines.map((line) => solutionKey(line.placements));
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("two orders of the same pieces are not merged when they score differently", () => {
    // The transposition table's whole job is to notice that two orders reach the
    // same position. Combo is the part of "the same position" that is not on the
    // board: the engine multiplies damage by `1 + 0.25 * combo`, so a quiet
    // placement followed by a clearing one, and the same two the other way
    // round, leave an identical board, hold, piece set, attack and clear
    // multiset — and a different combo. Everything after them is worth
    // different amounts.
    //
    // Keyed without it, this position returned 16 lines and said `exhausted`
    // while four real solving lines were unreachable, which is the one claim
    // this tool must never make wrongly.
    const report = searchSolutions(
      puzzleOf({
        board: ["GGGGGGGGG.", "GGGGGGGGG.", "GGGGGGGGG.", "GGGGGGGGG.", "GGGGGG...."],
        queue: ["I", "I", "I"],
        targetAttack: 5,
      }),
      { maxLines: 500, maxNodes: 5_000_000, maxMillis: 60_000 },
    );

    expect(report.stoppedBy).toBe("exhausted");
    // Counted, not sampled. A "does some line score quad+single" check passes
    // with the bug reinstated, because other lines reach the same shape by
    // other seats — the loss is four *specific* orders, not a whole category.
    expect(
      report.lines.length,
      "The transposition key has stopped carrying the engine's combo/b2b state,\n" +
        "so two orders worth different amounts are being merged. This position\n" +
        "loses exactly four real solving lines that way, while the search still\n" +
        "reports `exhausted` — the one claim this tool must never make wrongly.",
    ).toBe(20);
    // And the named one among them, so the count cannot be satisfied by four
    // lines arriving from somewhere else.
    // Seats only: `solutionKey` is deliberately the piece and where it came to
    // rest, with the run's totals asked at the fingerprint level instead.
    const dropped = solutionKey([
      { piece: "I", cells: [[0, 5], [0, 6], [0, 7], [0, 8]] },
      { piece: "I", cells: [[6, 4], [7, 4], [8, 4], [9, 4]] },
      { piece: "I", cells: [[9, 0], [9, 1], [9, 2], [9, 3]] },
    ]);
    expect(report.lines.map((line) => solutionKey(line.placements))).toContain(dropped);
  });

  test("a line found at a slow soft drop lands where it says it lands", () => {
    // Nothing else in this suite runs the search at anything but the default,
    // so the handling threaded into `ticksForRoute` was unobservable and
    // reverting it was a silent no-op.
    //
    // It is not cosmetic. `plainRouteTo` returns the walk's path to a seat, and
    // that walk drops a piece all the way to rest before the moves and kicks
    // that follow — so its soft drop is how the piece gets *down*, not
    // decoration. Reporting no descents means one held tick, which at `sdf 5`
    // falls a quarter of a row, and every later move fires from the wrong
    // height. Measured over the archive: 456 of 3380 quiet seats lock on
    // different squares at `sdf 5`, while the search records the seat it asked
    // for and still reports `exhausted`.
    //
    // Archive puzzle 37, not a made-up board: a synthetic well passed either
    // way, and this test's whole job is to fail when the search stops measuring
    // below the instant setting. Three pieces, so it exhausts in about two
    // seconds even with every seat measured.
    const slow = { ...DEFAULT_HANDLING, sdf: 5 };
    const puzzle = puzzleOf({
      board: ["G.....GGGG", "G......GGG", "G.J...GGGG", "JJJ......."],
      queue: ["L", "S", "T"],
      hold: null,
      targetAttack: 4,
      requiredClears: [{ clear: "tsd", count: 1 }],
    });

    const report = searchSolutions(puzzle, { ...GENEROUS, maxLines: 6, maxMillis: 20_000 }, slow);
    expect(report.lines.length).toBeGreaterThan(0);

    const seats = (cells: readonly (readonly [number, number])[]) =>
      [...cells].map(([x, y]) => `${x},${y}`).sort().join(" ");

    for (const line of report.lines) {
      const replayed = replayPlacements(
        { board: decodeBoard(puzzle.board, ENGINE_ROWS), queue: puzzle.queue, hold: puzzle.hold },
        slow,
        line.placements.map((step) => ({ piece: step.piece, cells: step.cells })),
      );
      replayed.steps.forEach((step, index) => {
        expect(
          seats(step.cells),
          "a placement the search reported does not land there when replayed at\n" +
            "the same handling — the soft-drop descents are not reaching\n" +
            "`ticksForRoute`, so the fall stops short of the seat that was chosen.",
        ).toBe(seats(line.placements[index]!.cells));
      });
    }
  });

  test("a search that ran out says so, and never claims to have exhausted", () => {
    const stopped = searchSolutions(QUAD_WELL, { ...GENEROUS, maxNodes: 1 });
    expect(stopped.stoppedBy).not.toBe("exhausted");
  });

  test("hitting the line limit is reported as the limit, not as completeness", () => {
    // The distinction the whole tool rests on: a maker reading "exhausted"
    // takes it as proof their puzzle is tight, so every other way of stopping
    // has to be visibly not that.
    const capped = searchSolutions(QUAD_WELL, { ...GENEROUS, maxLines: 1 });

    expect(capped.lines).toHaveLength(1);
    expect(capped.stoppedBy).toBe("lines");
  });

  test("the defaults are bounded, so no caller can start an endless search", () => {
    expect(DEFAULT_LIMITS.maxMillis).toBeGreaterThan(0);
    expect(DEFAULT_LIMITS.maxNodes).toBeGreaterThan(0);
    expect(DEFAULT_LIMITS.maxLines).toBeGreaterThan(0);
  });

  test("every placement it returns is one the engine really locked there", () => {
    // The scores come off real locks, so a line's own arithmetic has to add up:
    // the attack it claims is the sum of the placements it made.
    const report = searchSolutions(QUAD_WELL, GENEROUS);

    for (const line of report.lines) {
      const summed = line.placements.reduce((total, step) => total + step.attack, 0);
      expect(summed).toBe(line.attack);
      const named = line.placements
        .map((step) => step.clear)
        .filter((clear): clear is NonNullable<typeof clear> => clear !== null);
      expect([...line.clears].sort()).toEqual([...named].sort());
      for (const step of line.placements) expect(step.cells).toHaveLength(4);
    }
  });
});
