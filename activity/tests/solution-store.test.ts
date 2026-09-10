/**
 * The database is what stops the same discovery being credited twice.
 *
 * Not a check in a route — a UNIQUE index. Two players who find the same line in
 * the same instant both reach the insert; exactly one of them can win, and the
 * loser is told it is already known rather than handed somebody else's credit.
 * Written as SELECT-then-INSERT that is a race, and the race gives the point
 * away twice.
 *
 * That index is now *partial*, over the rows an edit has not voided, and the
 * two halves of what that buys are both pinned below: a player keeps credit for
 * a line whose board has since changed, and the next player to find that line
 * on the new board is credited rather than refused as a duplicate.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type NewSolution } from "../server/db";
import { voidDiscoveries } from "../server/archive-rows";
import type { SolutionStep } from "../shared/puzzle";

const DB = join(tmpdir(), `puzzle-solutions-${process.pid}.sqlite`);

const PLACEMENTS: SolutionStep[] = [
  { piece: "T", cells: [[3, 0], [4, 0], [5, 0], [4, 1]], clear: "tsd", attack: 4 },
];

function line(over: Partial<NewSolution> = {}): NewSolution {
  return {
    puzzleId: 93, canonicalKey: "v1|4|tsd|T:3,0 4,0 4,1 5,0:tsd:4", keyVersion: 1,
    placements: PLACEMENTS, events: null, handling: null,
    attack: 4, targetAttack: 4, clears: ["tsd"], solvedStrict: true,
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
    expect(store.discoveryBoard().map((r) => [r.player.id, r.found])).toEqual([["ada", 1]]);
  });

  test("a different line on the same puzzle is a new discovery", () => {
    store.recordSolution(line());
    expect(store.recordSolution(line({ canonicalKey: "v1|4|tsd|OTHER", foundBy: "bo" })).discovered).toBe(true);
    expect(store.discoveryBoard().length).toBe(2);
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
    expect(store.discoveryBoard()).toEqual([]);
  });

  test("a line that misses the puzzle's goal is evidence, not a point", () => {
    // It is still filed — a puzzle maker wants to see it — but it does not score.
    store.recordSolution(line({ solvedStrict: false }));
    expect(store.solutionsFor(93).length).toBe(1);
    expect(store.discoveryBoard()).toEqual([]);
  });

  test("every distinct line counts, including several on one puzzle", () => {
    for (let n = 0; n < 5; n++) {
      store.recordSolution(line({ canonicalKey: `line-${n}` }));
    }
    expect(store.discoveryBoard().map((r) => r.found)).toEqual([5]);
  });

  test("a line found twice is still one line", () => {
    // The unique index is the only dedup there is, and it is the one that has
    // to hold: without it a player could re-file the same solve for a point.
    store.recordSolution(line({ canonicalKey: "a" }));
    store.recordSolution(line({ canonicalKey: "a" }));
    expect(store.discoveryBoard().map((r) => r.found)).toEqual([1]);
  });

  test("lines are counted across puzzles too", () => {
    store.recordSolution(line({ puzzleId: 93, canonicalKey: "a" }));
    store.recordSolution(line({ puzzleId: 94, canonicalKey: "b" }));
    expect(store.discoveryBoard().map((r) => r.found)).toEqual([2]);
  });

  test("one board for every server, not one per guild", () => {
    // The archive is the same archive wherever it is played, and `guild_id`
    // records where a line was filed rather than who found it — so a per-guild
    // board split one player's own finds across two boards.
    store.recordSolution(line({ canonicalKey: "a", guildId: "g1" }));
    store.recordSolution(line({ puzzleId: 94, canonicalKey: "b", guildId: "g2" }));
    expect(store.discoveryBoard().map((r) => [r.player.id, r.found])).toEqual([["ada", 2]]);
  });
});

describe("where the reader stands", () => {
  test("nothing found is no rank, rather than a rank of nothing", () => {
    expect(store.discoveryStanding("ada")).toBeNull();
  });

  test("the rank counts everyone strictly ahead", () => {
    store.recordSolution(line({ canonicalKey: "a" }));
    store.recordSolution(line({ canonicalKey: "b" }));
    store.recordSolution(line({ canonicalKey: "c", foundBy: "bo" }));
    expect(store.discoveryStanding("ada")).toEqual({ rank: 1, found: 2 });
    expect(store.discoveryStanding("bo")).toEqual({ rank: 2, found: 1 });
  });

  test("a tie reads as a tie, not as one worse", () => {
    // The board orders `found DESC, latest ASC`, so a rank counted as "rows
    // above me" would put the later of two equal finders at 2 while the board
    // shows them level.
    store.recordSolution(line({ canonicalKey: "a" }));
    store.recordSolution(line({ canonicalKey: "b", foundBy: "bo" }));
    const board = store.discoveryBoard();
    expect(board.map((r) => r.found)).toEqual([1, 1]);
    // Whoever the board puts second is still on one line, and one line is
    // whatever rank one line is.
    const second = board[1]!.player.id;
    expect(store.discoveryStanding(second)!.found).toBe(1);
  });
});

describe("a puzzle edited under its finders", () => {
  test("keeps their credit and drops the line from the puzzle", () => {
    store.recordSolution(line({ canonicalKey: "a" }));
    voidDiscoveries(store.archiveReader, 93);

    // The claim is dead: it is not a line on the board sitting there now.
    expect(store.solutionsFor(93)).toEqual([]);
    expect(store.countSolutions(93)).toBe(0);
    expect(store.solutionCounts()).toEqual([]);
    // The finding is not. Ada found it, and an edit is not a reason to say she did not.
    expect(store.discoveryBoard().map((r) => [r.player.id, r.found])).toEqual([["ada", 1]]);
    expect(store.discoveryStanding("ada")).toEqual({ rank: 1, found: 1 });
  });

  test("lets the next finder of that same line be credited on the new board", () => {
    // The old index covered every row, so a kept row went on holding its key
    // and refused the next genuine discovery as a duplicate. That is the whole
    // reason voiding used to have to destroy the row.
    store.recordSolution(line({ canonicalKey: "a" }));
    voidDiscoveries(store.archiveReader, 93);

    expect(store.recordSolution(line({ canonicalKey: "a", foundBy: "bo" })).discovered).toBe(true);
    expect(store.discoveryBoard().map((r) => r.player.id).sort()).toEqual(["ada", "bo"]);
  });

  test("does not restamp what an earlier edit already retired", () => {
    store.recordSolution(line({ canonicalKey: "a" }));
    voidDiscoveries(store.archiveReader, 93);
    const first = store.archiveReader
      .query<{ voided_at: number }, []>("SELECT voided_at FROM puzzle_solutions")
      .get()!.voided_at;

    store.recordSolution(line({ canonicalKey: "b" }));
    voidDiscoveries(store.archiveReader, 93);
    const both = store.archiveReader
      .query<{ voided_at: number }, []>(
        "SELECT voided_at FROM puzzle_solutions ORDER BY solution_id",
      )
      .all();

    // The stamp says when a line stopped describing its board. Moving the first
    // one forward to the second edit would lose that.
    expect(both[0]!.voided_at).toBe(first);
    expect(both[1]!.voided_at).toBeGreaterThanOrEqual(first);
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
