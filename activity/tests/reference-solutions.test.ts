/**
 * The archive's own answer is a solution on record, not a discovery waiting to
 * happen.
 *
 * `recordDiscovery` decides "nobody had found this line before" purely by
 * fingerprint novelty, and the intended solution was never written down. So the
 * first player to solve a puzzle *the way its maker did* collided with nothing,
 * and was told they had discovered an alternate — on every puzzle, once. It also
 * inflated the "N distinct lines" count by one everywhere, and left the second
 * player to find the intended line correctly uncredited, which reads as the
 * feature being arbitrary.
 *
 * `SolutionSource` has carried a `reference` case since the table was written and
 * `discoveryBoard` already excludes it by name — "the archive's own answers and
 * everything the batch enumerator turns up belong to nobody". Nothing ever wrote
 * one. This is the producer.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/db";
import { recordDiscovery, seedReferenceSolutions } from "../server/discoveries";
import { DEFAULT_HANDLING } from "../shared/tetris/handling";
import type { Puzzle } from "../shared/puzzle";
import type { VerifiedRun } from "../shared/tetris/verify";

const INTENDED = [
  { piece: "T", cells: [[0, 0], [1, 0], [2, 0], [1, 1]], clear: "tsd", attack: 4 },
];
/** The same board solved by a different line: different cells, same outcome. */
const ALTERNATE = [
  { piece: "T", cells: [[5, 0], [6, 0], [7, 0], [6, 1]], clear: "tsd", attack: 4 },
];

function puzzle(over: Partial<Puzzle> = {}): Puzzle {
  return {
    id: 7,
    title: "tuck the T",
    goal: "Clear a TSD",
    targetAttack: 4,
    requiredClears: [{ clear: "tsd", count: 1 }],
    solution: INTENDED,
    ...over,
  } as unknown as Puzzle;
}

function ran(placements: typeof INTENDED): VerifiedRun {
  return {
    attack: 4,
    clears: placements.map((p) => p.clear),
    placements: placements.map((p) => ({ ...p, frame: 1 })),
    durationMs: 1000,
    toppedOut: false,
  } as unknown as VerifiedRun;
}

const FINDER = { playerId: "p1", guildId: null };

describe("seedReferenceSolutions", () => {
  let dir: string;
  let store: Store;
  let db: Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reference-solutions-"));
    store = new Store(join(dir, "t.sqlite"));
    db = new Database(join(dir, "t.sqlite"));
  });
  afterEach(() => {
    db.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const rows = () =>
    db.query("SELECT source, found_by, solved_strict FROM puzzle_solutions").all() as {
      source: string;
      found_by: string | null;
      solved_strict: number;
    }[];

  test("files one row for a puzzle that has an answer", () => {
    expect(seedReferenceSolutions(store, [puzzle()])).toEqual({ seeded: 1, skipped: 0 });
    expect(rows()).toHaveLength(1);
  });

  test("the row belongs to nobody, so no board can pay for it", () => {
    seedReferenceSolutions(store, [puzzle()]);

    const [row] = rows();
    expect(row!.source).toBe("reference");
    expect(row!.found_by).toBeNull();
  });

  test("a player who replays the intended line is not credited with finding it", () => {
    seedReferenceSolutions(store, [puzzle()]);

    const found = recordDiscovery(store, puzzle(), ran(INTENDED), [], DEFAULT_HANDLING, FINDER);

    expect(found?.isNew).toBe(false);
  });

  test("a genuinely different line is still a discovery", () => {
    seedReferenceSolutions(store, [puzzle()]);

    const found = recordDiscovery(store, puzzle(), ran(ALTERNATE), [], DEFAULT_HANDLING, FINDER);

    expect(found?.isNew).toBe(true);
  });

  test("the count players are shown does not include the seeded answer twice", () => {
    seedReferenceSolutions(store, [puzzle()]);
    seedReferenceSolutions(store, [puzzle()]);

    expect(rows()).toHaveLength(1);
  });

  test("seeding twice files once, so every boot may run it", () => {
    expect(seedReferenceSolutions(store, [puzzle()])).toEqual({ seeded: 1, skipped: 0 });
    expect(seedReferenceSolutions(store, [puzzle()])).toEqual({ seeded: 0, skipped: 0 });
  });

  test("a puzzle with no answer on this box is skipped, not thrown on", () => {
    // The production state: `data/solutions.json` is untracked and absent, so
    // every club puzzle arrives without its answer. Seeding must degrade to
    // doing nothing rather than taking the boot down.
    const answerless = puzzle({ solution: undefined });

    expect(() => seedReferenceSolutions(store, [answerless])).not.toThrow();
    expect(seedReferenceSolutions(store, [answerless])).toEqual({ seeded: 0, skipped: 1 });
    expect(rows()).toHaveLength(0);
  });

  test("records whether the answer meets the puzzle's own rule", () => {
    seedReferenceSolutions(store, [puzzle()]);

    expect(rows()[0]!.solved_strict).toBe(1);
  });
});
