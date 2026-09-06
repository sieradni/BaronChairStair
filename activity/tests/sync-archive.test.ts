/**
 * The sync tool, run as the command it actually is.
 *
 * A subprocess rather than an import, because the things worth checking here
 * are the ones a unit test of `upsertArchive` cannot see: that `--dry-run`
 * really rolls its transaction back, that a puzzle which will not replay is
 * skipped rather than written half-formed, and that a drift exits non-zero so a
 * scheduled run cannot report success while quietly refusing to apply the
 * sheet.
 *
 * The fixture is three real rows off the club's sheet: two that build, and #13,
 * whose recorded answer has a step the router cannot reach.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { archiveCounts, archiveEntry, publishArchive } from "../server/archive-rows";

const TOOL = resolve(import.meta.dir, "../tools/sync-archive.ts");
const SHEET = resolve(import.meta.dir, "fixtures/archive-sheet");
const CODES = "Copy of Puzzles Archive - blueprint urls.csv";

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sync-archive-"));
  dbPath = join(dir, "daily.sqlite");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function sync(...args: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["bun", "run", TOOL, "--db", dbPath, "--from", SHEET, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, out: out + err };
}

/** The fixture, with #1 and #2's blueprints swapped: an id kept, its puzzle replaced. */
function sheetWithSwappedPuzzles(): string {
  const swapped = join(dir, "swapped");
  cpSync(SHEET, swapped, { recursive: true });
  const path = join(swapped, CODES);
  const rows = readFileSync(path, "utf8").split("\n");
  // The fixture is minimally quoted, so an id is a bare leading field.
  const at = (id: string) => rows.findIndex((row) => row.split(",")[0]?.trim() === id);
  const [one, two] = [at("1"), at("2")];
  if (one < 0 || two < 0) throw new Error("fixture lost puzzle 1 or 2");
  const body = (row: string) => row.slice(row.indexOf(",") + 1);
  [rows[one], rows[two]] = [`1,${body(rows[two]!)}`, `2,${body(rows[one]!)}`];
  writeFileSync(path, rows.join("\n"));
  return swapped;
}

describe("syncing from a sheet", () => {
  test("writes the puzzles that replay, and skips the one that does not", async () => {
    const { code, out } = await sync();

    expect(code).toBe(0);
    expect(out).toContain("added 2");
    expect(out).toContain("#13:");

    const db = new Database(dbPath);
    try {
      expect(archiveCounts(db)).toEqual({ published: 0, pending: 2 });
      expect(archiveEntry(db, 13)).toBeNull();
      // The target is the engine's reading of the answer, not a sheet column.
      expect(archiveEntry(db, 1)!.puzzle.targetAttack).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  test("a second run changes nothing", async () => {
    await sync();
    const { out } = await sync();

    expect(out).toContain("added 0, amended 0, unchanged 2");
  });

  test("--dry-run rolls back everything it did", async () => {
    const { code, out } = await sync("--dry-run");

    expect(code).toBe(0);
    expect(out).toContain("would add 2");
    expect(out).toContain("nothing was written");

    const db = new Database(dbPath);
    try {
      expect(archiveCounts(db)).toEqual({ published: 0, pending: 0 });
    } finally {
      db.close();
    }
  });
});

describe("when a published puzzle's content moves", () => {
  test("it is refused, reported, and the run exits non-zero", async () => {
    await sync();
    const db = new Database(dbPath);
    const before = archiveEntry(db, 1)!.contentHash;
    publishArchive(db, [1, 2], "an officer", Date.now());
    db.close();

    const proc = Bun.spawn(
      ["bun", "run", TOOL, "--db", dbPath, "--from", sheetWithSwappedPuzzles()],
      { stdout: "pipe", stderr: "pipe" },
    );
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;

    expect(code).toBe(1);
    expect(out).toContain("2 PUBLISHED puzzle(s) have changed content");

    const after = new Database(dbPath);
    try {
      // The whole point: the row a player's score is filed against did not move.
      expect(archiveEntry(after, 1)!.contentHash).toBe(before);
      expect(archiveEntry(after, 1)!.publishedBy).toBe("an officer");
    } finally {
      after.close();
    }
  });

  test("the same move on an unpublished puzzle is applied", async () => {
    await sync();
    const db = new Database(dbPath);
    const before = archiveEntry(db, 1)!.contentHash;
    db.close();

    const proc = Bun.spawn(
      ["bun", "run", TOOL, "--db", dbPath, "--from", sheetWithSwappedPuzzles()],
      { stdout: "pipe", stderr: "pipe" },
    );
    const code = await proc.exited;

    expect(code).toBe(0);
    const after = new Database(dbPath);
    try {
      expect(archiveEntry(after, 1)!.contentHash).not.toBe(before);
    } finally {
      after.close();
    }
  });
});
