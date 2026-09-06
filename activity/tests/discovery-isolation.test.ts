/**
 * A discovery is never worth the run it came from.
 *
 * `recordDiscovery` runs *after* the run is recorded, which is the right order
 * and, on its own, not enough: the row already stands, so anything that throws
 * here takes down the response rather than the run. The player would see an
 * error and lose the verdict, the solution and the leaderboard that came with
 * it, for a run that in fact counted and is on the board.
 *
 * The store is faked here rather than driven, because the interesting inputs
 * are the failures a real sqlite store will not produce on demand.
 */

import { describe, expect, mock, test } from "bun:test";
import { recordDiscovery } from "../server/discoveries";
import type { Store } from "../server/db";
import type { Puzzle } from "../shared/puzzle";
import type { VerifiedRun } from "../shared/tetris/verify";
import { DEFAULT_HANDLING } from "../shared/tetris/handling";

const PUZZLE = {
  id: 7,
  goal: "Clear a TSD",
  targetAttack: 4,
  requiredClears: [{ clear: "tsd" as const, count: 1 }],
} as unknown as Puzzle;

const SOLVED = {
  attack: 4,
  clears: ["tsd"],
  placements: [{ piece: "T", cells: [[0, 0]], clear: "tsd", attack: 4, frame: 1 }],
  durationMs: 1000,
  toppedOut: false,
} as unknown as VerifiedRun;

const FINDER = { playerId: "p1", guildId: "g1" };

function storeThat(
  record: () => { solutionId: number | null; discovered: boolean },
  count: () => number = () => 1,
): Store {
  return { recordSolution: record, countSolutions: count } as unknown as Store;
}

function quietly<T>(run: () => T): T {
  const error = console.error;
  console.error = mock(() => {});
  try {
    return run();
  } finally {
    console.error = error;
  }
}

describe("a failing store cannot cost a player their run", () => {
  test("a store that throws on write reports no discovery, and does not throw", () => {
    const exploding = storeThat(() => {
      throw new Error("database is locked");
    });

    const discovery = quietly(() =>
      recordDiscovery(exploding, PUZZLE, SOLVED, [], DEFAULT_HANDLING, FINDER),
    );

    expect(discovery).toBeNull();
  });

  test("a store that writes but cannot count still reports the discovery", () => {
    // The row is on disk. Discarding the discovery because a COUNT failed would
    // throw away something that actually happened.
    const halfBroken = storeThat(
      () => ({ solutionId: 1, discovered: true }),
      () => {
        throw new Error("no such table");
      },
    );

    const discovery = quietly(() =>
      recordDiscovery(halfBroken, PUZZLE, SOLVED, [], DEFAULT_HANDLING, FINDER),
    );

    expect(discovery).toEqual({ isNew: true, known: 0 });
  });

  test("the ordinary case is unchanged", () => {
    const working = storeThat(() => ({ solutionId: 1, discovered: true }), () => 3);

    expect(recordDiscovery(working, PUZZLE, SOLVED, [], DEFAULT_HANDLING, FINDER)).toEqual({
      isNew: true,
      known: 3,
    });
  });

  test("a run that did not reach the target is never filed at all", () => {
    const never = storeThat(() => {
      throw new Error("should not be called");
    });
    const short = { ...SOLVED, attack: 1 } as unknown as VerifiedRun;

    expect(recordDiscovery(never, PUZZLE, short, [], DEFAULT_HANDLING, FINDER)).toBeNull();
  });
});
