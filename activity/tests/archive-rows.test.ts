/**
 * The archive table's two promises: a synced row is not playable until somebody
 * publishes it, and an edit to a published puzzle is applied but never silent.
 *
 * A creator may go back and edit their own puzzle, so the content moves. What
 * that costs is recorded rather than prevented: `runs` and `day_puzzles`
 * reference a puzzle by id and keep no copy of the board, so after the UPDATE
 * `archive_content_log` is the only thing that can say what a finished score
 * was set on. Rebuilding today's sheet edits twelve published puzzles, and #8 is
 * a different puzzle outright — same id, new board, new queue, new title.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveCounts,
  archiveEntry,
  contentHash,
  contentHistory,
  pendingArchive,
  publishArchive,
  readPublishedArchive,
  upsertArchive,
} from "../server/archive-rows";
import { Store } from "../server/db";
import { COMMUNITY_ID_BASE, type ClearRequirement, type Puzzle } from "../shared/puzzle";

let dir: string;
let store: Store;
let db: Database;

const NOW = 1_700_000_000_000;

function puzzle(over: Partial<Puzzle> = {}): Puzzle {
  return {
    id: 1,
    title: "a puzzle",
    author: "someone",
    difficulty: 4,
    goal: "Send a TSD",
    set: "spring",
    board: ["....xxxxxx", "....xxxxxx"],
    queue: ["T", "I", "O"],
    hold: null,
    targetAttack: 4,
    // A real ClearName, not a line count: `clearShortfall` matches on the name,
    // and a number here silently fails every requirement check.
    solution: [{ piece: "T", cells: [[0, 0], [1, 0], [2, 0], [1, 1]], clear: "tsd", attack: 4 }],
    source: { puzzle: "code-a", solution: "code-b" },
    ...over,
  } as Puzzle;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "archive-rows-"));
  store = new Store(join(dir, "t.sqlite"));
  db = new Database(join(dir, "t.sqlite"));
});

afterEach(() => {
  db.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("syncing", () => {
  test("a new puzzle is written unpublished, and is not served", () => {
    expect(upsertArchive(db, puzzle(), NOW)).toEqual({ kind: "added" });

    expect(readPublishedArchive(db)).toEqual([]);
    expect(pendingArchive(db).map((e) => e.puzzle.id)).toEqual([1]);
    expect(archiveCounts(db)).toEqual({ published: 0, pending: 1 });
  });

  test("re-syncing an identical puzzle writes nothing", () => {
    upsertArchive(db, puzzle(), NOW);
    expect(upsertArchive(db, puzzle(), NOW + 5000)).toEqual({ kind: "unchanged" });
    expect(archiveEntry(db, 1)?.syncedAt).toBe(NOW);
  });

  test("a corrected title on a published puzzle flows through", () => {
    upsertArchive(db, puzzle(), NOW);
    publishArchive(db, [1], "officer", NOW);

    const outcome = upsertArchive(db, puzzle({ title: "the real title" }), NOW + 1);

    expect(outcome).toEqual({ kind: "amended", fields: ["title"] });
    expect(readPublishedArchive(db)[0]?.title).toBe("the real title");
  });

  test("an unpublished puzzle's content may be replaced outright", () => {
    upsertArchive(db, puzzle(), NOW);
    const moved = puzzle({ queue: ["S", "Z", "L"], targetAttack: 9 });

    const outcome = upsertArchive(db, moved, NOW + 1);

    expect(outcome.kind).toBe("amended");
    expect(archiveEntry(db, 1)?.puzzle.queue).toEqual(["S", "Z", "L"]);
    expect(archiveEntry(db, 1)?.contentHash).toBe(contentHash(moved));
  });
});

describe("a creator editing a published puzzle", () => {
  /** The shape of what the sheet did to puzzle #8. */
  const REPLACED = { queue: ["S", "Z", "L"], title: "misplaced heart" } as const;

  beforeEach(() => {
    upsertArchive(db, puzzle(), NOW);
    publishArchive(db, [1], "officer", NOW);
  });

  test("the edit is applied, and reported as its own outcome", () => {
    const outcome = upsertArchive(db, puzzle(REPLACED), NOW + 1, "a creator");

    expect(outcome.kind).toBe("edited");
    if (outcome.kind !== "edited") throw new Error("unreachable");
    expect(outcome.from).toBe(contentHash(puzzle()));
    expect(outcome.to).toBe(contentHash(puzzle(REPLACED)));
    // The metadata that moved alongside the content, which the sync prints.
    expect(outcome.fields).toEqual(["title"]);
    expect(readPublishedArchive(db)[0]?.queue).toEqual(["S", "Z", "L"]);
  });

  test("records who made the change, defaulting to the tool", () => {
    upsertArchive(db, puzzle(REPLACED), NOW + 1);

    expect(contentHistory(db, 1)[0]?.by).toBe("sync-archive");
  });

  test("it stays published, and stays published by whoever published it", () => {
    upsertArchive(db, puzzle(REPLACED), NOW + 1);

    expect(archiveEntry(db, 1)?.publishedBy).toBe("officer");
    expect(archiveEntry(db, 1)?.publishedAt).toBe(NOW);
    expect(readPublishedArchive(db)).toHaveLength(1);
  });

  test("the puzzle it used to be is recoverable afterwards", () => {
    // The whole reason the log exists: the UPDATE is what destroys this, and
    // runs and day_puzzles keep no copy of the board a score was set on.
    upsertArchive(db, puzzle(REPLACED), NOW + 1, "a creator");

    const history = contentHistory(db, 1);
    expect(history).toHaveLength(1);
    expect(history[0]?.wasHash).toBe(contentHash(puzzle()));
    expect(history[0]?.becameHash).toBe(contentHash(puzzle(REPLACED)));
    expect(history[0]?.wasPublished).toBe(true);
    expect(history[0]?.by).toBe("a creator");
    // Pinned because a log that cannot say when or who is a log nobody can act
    // on: both survived a mutation pass that blanked them.
    expect(history[0]?.at).toBe(NOW + 1);

    const row = db
      .query<{ was_queue: string; was_target: number }, [number]>(
        "SELECT was_queue, was_target FROM archive_content_log WHERE puzzle_id = ?1",
      )
      .get(1);
    expect(JSON.parse(row!.was_queue)).toEqual(["T", "I", "O"]);
    expect(row!.was_target).toBe(4);
  });

  test("editing twice keeps both entries, oldest first", () => {
    upsertArchive(db, puzzle(REPLACED), NOW + 1);
    upsertArchive(db, puzzle({ queue: ["J", "L", "T"] }), NOW + 2);

    const history = contentHistory(db, 1);
    expect(history).toHaveLength(2);
    expect(history[0]!.entryId).toBeLessThan(history[1]!.entryId);
    expect(history[1]?.wasHash).toBe(contentHash(puzzle(REPLACED)));
  });

  test("a metadata-only correction is not logged as a content change", () => {
    const outcome = upsertArchive(db, puzzle({ title: "renamed" }), NOW + 1);

    expect(outcome.kind).toBe("amended");
    expect(contentHistory(db, 1)).toEqual([]);
  });
});

describe("the frozen clear requirement, when content is edited", () => {
  const TSD: readonly ClearRequirement[] = [{ clear: "tsd", count: 1 }];
  /** A solution that clears nothing, so the frozen requirement cannot be met. */
  const NO_CLEARS = {
    solution: [{ piece: "T", cells: [[0, 0], [1, 0], [2, 0], [1, 1]], clear: null, attack: 4 }],
  } as Partial<Puzzle>;

  beforeEach(() => {
    upsertArchive(db, puzzle({ requiredClears: TSD }), NOW);
    publishArchive(db, [1], "officer", NOW);
  });

  test("is dropped when the new answer no longer meets it", () => {
    // Left in place it would demand a clear the puzzle's own answer never makes,
    // which is an unsolvable published puzzle.
    const outcome = upsertArchive(db, puzzle({ ...NO_CLEARS, queue: ["S", "Z", "L"] }), NOW + 1);

    expect(outcome.kind).toBe("edited");
    if (outcome.kind !== "edited") throw new Error("unreachable");
    expect(outcome.droppedClears).toEqual(TSD);
    expect(archiveEntry(db, 1)?.puzzle.requiredClears).toBeUndefined();
  });

  test("is kept when the new answer still meets it", () => {
    const outcome = upsertArchive(db, puzzle({ queue: ["S", "Z", "L"] }), NOW + 1);

    expect(outcome.kind).toBe("edited");
    if (outcome.kind !== "edited") throw new Error("unreachable");
    expect(outcome.droppedClears).toBeNull();
    expect(archiveEntry(db, 1)?.puzzle.requiredClears).toEqual(TSD);
  });

  test("the dropped requirement survives in the log", () => {
    upsertArchive(db, puzzle({ ...NO_CLEARS, queue: ["S", "Z", "L"] }), NOW + 1);

    expect(contentHistory(db, 1)[0]?.wasClears).toEqual(TSD);
  });
});

describe("publishing", () => {
  beforeEach(() => {
    upsertArchive(db, puzzle({ id: 1 }), NOW);
    upsertArchive(db, puzzle({ id: 2 }), NOW);
  });

  test("makes rows readable and records who did it", () => {
    expect(publishArchive(db, [1, 2], "officer", NOW)).toEqual([1, 2]);

    expect(readPublishedArchive(db).map((p) => p.id)).toEqual([1, 2]);
    expect(archiveEntry(db, 1)?.publishedBy).toBe("officer");
    expect(archiveEntry(db, 1)?.publishedAt).toBe(NOW);
  });

  test("a second officer publishing the same rows changes nothing", () => {
    publishArchive(db, [1, 2], "first", NOW);

    expect(publishArchive(db, [1, 2], "second", NOW + 1)).toEqual([]);
    expect(archiveEntry(db, 1)?.publishedBy).toBe("first");
  });

  test("publishes only the rows named", () => {
    expect(publishArchive(db, [2], "officer", NOW)).toEqual([2]);
    expect(readPublishedArchive(db).map((p) => p.id)).toEqual([2]);
  });
});

describe("the community band", () => {
  test("a sheet id inside it is refused", () => {
    expect(() => upsertArchive(db, puzzle({ id: COMMUNITY_ID_BASE }), NOW)).toThrow(
      /outside the club band/,
    );
  });

  test("the id below it is fine", () => {
    expect(upsertArchive(db, puzzle({ id: COMMUNITY_ID_BASE - 1 }), NOW).kind).toBe("added");
  });
});

describe("the clear requirement", () => {
  test("survives a re-sync that does not carry one", () => {
    const clears: readonly ClearRequirement[] = [{ clear: "tsd", count: 1 }];
    upsertArchive(db, puzzle({ requiredClears: clears }), NOW);

    upsertArchive(db, puzzle({ title: "renamed" }), NOW + 1);

    expect(archiveEntry(db, 1)?.puzzle.requiredClears).toEqual(clears);
  });
});
