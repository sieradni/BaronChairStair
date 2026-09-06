/**
 * The database is what stops the same discovery being credited twice.
 *
 * Not a check in a route — a UNIQUE index. Two players who find the same line in
 * the same instant both reach the insert; exactly one of them can win, and the
 * loser is told it is already known rather than handed somebody else's credit.
 * Written as SELECT-then-INSERT that is a race, and the race gives the point
 * away twice.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type NewSolution } from "../server/db";
import type { SolutionStep } from "../shared/puzzle";

const DB = join(tmpdir(), `puzzle-solutions-${process.pid}.sqlite`);

const PLACEMENTS: SolutionStep[] = [
  { piece: "T", cells: [[3, 0], [4, 0], [5, 0], [4, 1]], clear: "tsd", attack: 4 },
];

function line(over: Partial<NewSolution> = {}): NewSolution {
  return {
    puzzleId: 93, canonicalKey: "v1|4|tsd|T:3,0 4,0 4,1 5,0:tsd:4", keyVersion: 1,
    placements: PLACEMENTS, events: null, handling: null,
    attack: 4, clears: ["tsd"], solvedStrict: true,
    source: "player", foundBy: "ada", guildId: "g1", ...over,
  };
}

let store: Store;

beforeEach(() => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(DB + suffix, { force: true });
  store = new Store(DB);
  store.upsertPlayer({ id: "ada", username: "Ada", avatarUrl: null });
  store.upsertPlayer({ id: "bo", username: "Bo", avatarUrl: null });
});

afterEach(() => {
  store.close();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(DB + suffix, { force: true });
});

describe("filing a solution", () => {
  test("the first finder discovers it", () => {
    expect(store.recordSolution(line()).discovered).toBe(true);
  });

  test("the second finder of the same line does not", () => {
    store.recordSolution(line());
    const second = store.recordSolution(line({ foundBy: "bo" }));
    expect(second.discovered).toBe(false);
    expect(second.solutionId).toBeNull();
    // And the credit stays with whoever was first.
    expect(store.discoveryBoard(null).map((r) => [r.player.id, r.found])).toEqual([["ada", 1]]);
  });

  test("a different line on the same puzzle is a new discovery", () => {
    store.recordSolution(line());
    expect(store.recordSolution(line({ canonicalKey: "v1|4|tsd|OTHER", foundBy: "bo" })).discovered).toBe(true);
    expect(store.discoveryBoard(null).length).toBe(2);
  });

  test("the same line on a different puzzle is its own discovery", () => {
    // #46-50 in the real archive are a training series: near-identical boards
    // that share an answer. The key is scoped per puzzle for exactly this.
    store.recordSolution(line());
    expect(store.recordSolution(line({ puzzleId: 46, foundBy: "bo" })).discovered).toBe(true);
  });
});

describe("what the board counts", () => {
  test("nobody is credited for the archive's own answer or the enumerator's", () => {
    store.recordSolution(line({ source: "reference", foundBy: null, canonicalKey: "k1" }));
    store.recordSolution(line({ source: "enumerated", foundBy: null, canonicalKey: "k2" }));
    expect(store.discoveryBoard(null)).toEqual([]);
  });

  test("a line that misses the puzzle's goal is evidence, not a point", () => {
    // It is still filed — a puzzle maker wants to see it — but it does not score.
    store.recordSolution(line({ solvedStrict: false }));
    expect(store.solutionsFor(93).length).toBe(1);
    expect(store.discoveryBoard(null)).toEqual([]);
  });

  test("one credit per player per puzzle, however many lines they file", () => {
    // Without this a single scripted player takes every slot on a loose puzzle,
    // and the archive has loose puzzles: #123's enforceable condition is
    // `attack >= 2`, and a partial search of that four-piece puzzle already
    // turned up 31 distinct lines.
    for (let n = 0; n < 5; n++) {
      store.recordSolution(line({ canonicalKey: `line-${n}` }));
    }
    expect(store.discoveryBoard(null).map((r) => r.found)).toEqual([1]);
  });

  test("but a player is credited once on each puzzle they open up", () => {
    store.recordSolution(line({ puzzleId: 93, canonicalKey: "a" }));
    store.recordSolution(line({ puzzleId: 94, canonicalKey: "b" }));
    expect(store.discoveryBoard(null).map((r) => r.found)).toEqual([2]);
  });

  test("a guild board counts only that guild's discoveries", () => {
    store.recordSolution(line({ canonicalKey: "a", guildId: "g1" }));
    store.recordSolution(line({ puzzleId: 94, canonicalKey: "b", guildId: "g2", foundBy: "bo" }));
    expect(store.discoveryBoard("g1").map((r) => r.player.id)).toEqual(["ada"]);
    expect(store.discoveryBoard(null).length).toBe(2);
  });
});

describe("what a puzzle maker reads", () => {
  test("counts every line, and says how many miss the goal", () => {
    store.recordSolution(line({ canonicalKey: "a" }));
    store.recordSolution(line({ canonicalKey: "b", solvedStrict: false }));
    store.recordSolution(line({ canonicalKey: "c", solvedStrict: false }));
    expect(store.solutionCounts()).toEqual([{ puzzleId: 93, total: 3, missingGoal: 2 }]);
  });
});
