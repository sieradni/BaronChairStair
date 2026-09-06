/**
 * The archive table's two promises: a synced row is not playable until somebody
 * publishes it, and a published puzzle's content cannot move underneath it.
 *
 * The second one is not hypothetical. Rebuilding today's sheet changes twelve
 * already-published puzzles, and #8 is a different puzzle outright — same id,
 * new board, new queue, new title. `runs` and `day_puzzles` reference a puzzle
 * by id and store no copy of what was played, so an overwrite silently re-files
 * finished scores against something nobody played.
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
    solution: [{ piece: "T", cells: [[0, 0], [1, 0], [2, 0], [1, 1]], clear: 2, attack: 4 }],
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

describe("a published puzzle's content cannot move", () => {
  /** The shape of what the sheet did to puzzle #8. */
  const REPLACED = { queue: ["S", "Z", "L"], title: "misplaced heart" } as const;

  beforeEach(() => {
    upsertArchive(db, puzzle(), NOW);
    publishArchive(db, [1], "officer", NOW);
  });

  test("the sync refuses it and says so", () => {
    const outcome = upsertArchive(db, puzzle(REPLACED), NOW + 1);

    expect(outcome.kind).toBe("drifted");
    if (outcome.kind !== "drifted") throw new Error("unreachable");
    expect(outcome.from).toBe(contentHash(puzzle()));
    expect(outcome.to).toBe(contentHash(puzzle(REPLACED)));
  });

  test("and the row is left exactly as it was", () => {
    upsertArchive(db, puzzle(REPLACED), NOW + 1);

    const served = readPublishedArchive(db)[0];
    expect(served?.queue).toEqual(["T", "I", "O"]);
    expect(served?.title).toBe("a puzzle");
    expect(archiveEntry(db, 1)?.syncedAt).toBe(NOW);
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
