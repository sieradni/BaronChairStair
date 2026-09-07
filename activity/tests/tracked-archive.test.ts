/**
 * The one database this repository commits, and the reasons it is safe to.
 *
 * `activity/data/archive/puzzles.sqlite` is the club's archive as a file, so a
 * fresh clone, a CI job or another project has the puzzles without running a
 * sync against the spreadsheet. Everything else under `activity/data/` is
 * gitignored, and this is the exception.
 *
 * **This repository is public.** The live `daily.sqlite` beside it holds real
 * Discord ids, usernames, avatar URLs, run history and submissions; committing
 * it would publish all of that, and — because SQLite is in WAL mode — would
 * capture a torn snapshot that leaks the players while missing the puzzles.
 * That file must never be tracked. This one is built fresh by
 * `tools/sync-archive.ts`, which creates only `ARCHIVE_SCHEMA`, so it has
 * never had a player table in it.
 *
 * These tests are the mechanism rather than the promise. The safe property is
 * "no table here can hold a person", and it is asserted rather than trusted,
 * the way `PuzzlePrompt` asserts that a player is never handed an answer.
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

const ARTIFACT = resolve(import.meta.dir, "../data/archive/puzzles.sqlite");

/** Everything a puzzles-only database may contain. Anything else is a leak. */
const ALLOWED = new Set(["archive_puzzles", "archive_content_log", "sqlite_sequence"]);

/** Column names that would mean a person is in the file. */
const IDENTIFYING = ["player", "guild", "user", "avatar", "discord", "found_by", "reviewed_by"];

function open(): Database {
  return new Database(ARTIFACT, { readonly: true });
}

describe("the committed archive", () => {
  test("exists, and is the file the rest of these tests describe", () => {
    expect(existsSync(ARTIFACT)).toBe(true);
    expect(statSync(ARTIFACT).size).toBeGreaterThan(0);
  });

  test("contains only the two archive tables", () => {
    const db = open();
    try {
      const tables = db
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row.name);

      const unexpected = tables.filter((name) => !ALLOWED.has(name));
      expect(unexpected).toEqual([]);
      expect(tables).toContain("archive_puzzles");
    } finally {
      db.close();
    }
  });

  test("has no column anywhere that could name a person", () => {
    const db = open();
    try {
      const tables = db
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row.name);

      const offenders: string[] = [];
      for (const table of tables) {
        const columns = db
          .query<{ name: string }, []>(`PRAGMA table_info("${table}")`)
          .all()
          .map((row) => row.name.toLowerCase());
        for (const column of columns) {
          if (IDENTIFYING.some((needle) => column.includes(needle))) {
            offenders.push(`${table}.${column}`);
          }
        }
      }
      expect(offenders).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("publishes nothing by being committed", () => {
    // Every row arrives unpublished, so cloning this file cannot change what
    // any player is served. Publishing stays a deliberate act somebody runs.
    const db = open();
    try {
      const row = db
        .query<{ published: number; total: number }, []>(
          "SELECT COUNT(published_at) AS published, COUNT(*) AS total FROM archive_puzzles",
        )
        .get();

      expect(row?.total).toBeGreaterThan(100);
      expect(row?.published).toBe(0);
    } finally {
      db.close();
    }
  });

  test("carries no write-ahead sidecar", () => {
    // A committed `-wal` would be both a stale-data trap and, for the live
    // database, the single largest thing in the directory.
    expect(existsSync(`${ARTIFACT}-wal`)).toBe(false);
    expect(existsSync(`${ARTIFACT}-shm`)).toBe(false);
  });

  test("every puzzle in it is engine-verified", () => {
    // The sync refuses a puzzle whose answer will not replay, so a target of
    // zero would mean something wrote to this file another way.
    const db = open();
    try {
      const bad = db
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM archive_puzzles WHERE target_attack <= 0 OR solution = '[]'",
        )
        .get();

      expect(bad?.n).toBe(0);
    } finally {
      db.close();
    }
  });
});
