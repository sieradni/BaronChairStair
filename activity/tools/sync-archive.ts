#!/usr/bin/env bun
/**
 * Pulls the puzzle archive out of the Google Sheet and into `archive_puzzles`.
 *
 *     bun run sync-archive [--dry-run] [--db <path>] [--from <dir>]
 *
 * The sheet is published, so both tabs come back as CSV from `gviz` with no
 * credentials and nothing to configure. `--from` reads the same two files off
 * disk instead, which is how this is tested and how it is run from a box with
 * no outbound network.
 *
 * **Nothing this writes is playable.** Rows land with `published_at` NULL, and
 * an officer publishes them separately. That is deliberate: the archive's
 * review gate used to be git — a puzzle arrived as a diff in a tracked file
 * that somebody approved — and this would otherwise be a script that silently
 * changes what the club plays tomorrow. Run it as often as you like.
 *
 * Every puzzle is decoded and replayed through the real engine by
 * `decode-archive.ts`, the same module `build-puzzles.ts` uses, so a puzzle
 * that reaches the table has a target somebody can actually be scored against.
 * One that will not replay is reported and skipped.
 *
 * **On holding the write lock.** Decoding and replaying the whole sheet takes
 * the better part of a second, and doing it inside the transaction held the WAL
 * write lock for all of it. Nothing in this repository sets `busy_timeout`, so
 * the server's next `recordRun` would not wait — it would fail instantly and a
 * player's finished solve would be lost. So the work is split: every puzzle is
 * built first, with no transaction open, and the transaction wraps only the
 * writes. This connection also sets its own `busy_timeout`, so if the server is
 * mid-write the sync waits for it rather than dying.
 *
 * It creates its one table from {@link ARCHIVE_SCHEMA} rather than constructing
 * a `Store`, for the reason `review-link.ts` gives: a Store construction runs
 * the whole schema plus the `addSlotsToRuns` rebuild, and a one-off command
 * that can take the server's database down is not a one-off command.
 */

import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { upsertArchive, type SyncOutcome } from "../server/archive-rows";
import type { Puzzle } from "../shared/puzzle";
import { ARCHIVE_SCHEMA } from "../server/db";
import { CODES_SHEET, META_SHEET, buildPuzzle, indexById } from "./decode-archive";
import { parseCsv } from "./csv";

/** The published sheet. Its id is not a secret; the document is world-readable. */
const SHEET_ID = "1OUA3w3Q1OAajaNLlp74CwrZhnBKRbkeo4hYux_v94QM";

/**
 * How long to wait for another writer before giving up. Generous: the only
 * other writer is the activity server, whose writes are single statements, and
 * waiting a few seconds is always better than a half-applied sync.
 *
 * Overridable so the test can hold a lock for less than ten seconds.
 */
const BUSY_TIMEOUT_MS = Number(process.env.SYNC_BUSY_TIMEOUT_MS ?? 10_000);

/** `gviz` exports one tab as CSV, addressed by tab name rather than by gid. */
function tabUrl(tab: string): string {
  return (
    `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq` +
    `?tqx=out:csv&sheet=${encodeURIComponent(tab)}`
  );
}

/** The tab name behind each of the build script's two filenames. */
const TAB_OF: Readonly<Record<string, string>> = {
  [CODES_SHEET]: "blueprint urls",
  [META_SHEET]: "Puzzles",
};

interface Options {
  dryRun: boolean;
  db: string;
  from: string | null;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    dryRun: false,
    db: process.env.DATABASE_PATH
      ? resolve(process.env.DATABASE_PATH)
      : resolve(import.meta.dir, "../data/daily.sqlite"),
    from: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    const value = argv[i + 1];
    if (!value) throw new Error(`Missing value for ${flag}`);
    if (flag === "--db") options.db = resolve(value);
    else if (flag === "--from") options.from = resolve(value);
    else throw new Error(`Unknown flag ${flag}`);
    i += 1;
  }
  return options;
}

async function fetchTab(sheet: string): Promise<string> {
  const tab = TAB_OF[sheet];
  if (!tab) throw new Error(`No tab known for ${sheet}`);
  const response = await fetch(tabUrl(tab));
  if (!response.ok) {
    // A sheet that stops being publicly readable answers 200 with a sign-in
    // page rather than 403, so the status alone is not enough — see below.
    throw new Error(`Sheet tab "${tab}" answered ${response.status}`);
  }
  const body = await response.text();
  if (body.trimStart().startsWith("<")) {
    throw new Error(
      `Sheet tab "${tab}" returned HTML, not CSV — the document is probably no ` +
        "longer shared with anyone who has the link.",
    );
  }
  return body;
}

async function readTab(options: Options, sheet: string): Promise<string> {
  return options.from ? readFileSync(join(options.from, sheet), "utf8") : fetchTab(sheet);
}

interface Report {
  added: number[];
  amended: { id: number; fields: readonly string[] }[];
  drifted: { id: number; from: string; to: string }[];
  unchanged: number;
  /** Puzzles whose answer would not decode or replay. A puzzle problem. */
  failed: { id: number; reason: string }[];
  /**
   * Rows that built fine and could not be written. Kept apart from `failed`
   * because they are not the same thing at all: a locked database reported as
   * "would not replay" blames the puzzle maker for the server being busy, and
   * the command that did it exited 0.
   */
  unwritten: { id: number; reason: string }[];
}

function record(report: Report, id: number, outcome: SyncOutcome): void {
  if (outcome.kind === "added") report.added.push(id);
  else if (outcome.kind === "unchanged") report.unchanged += 1;
  else if (outcome.kind === "amended") report.amended.push({ id, fields: outcome.fields });
  else report.drifted.push({ id, from: outcome.from, to: outcome.to });
}

function describe(report: Report, dryRun: boolean): void {
  const verb = dryRun ? "would add" : "added";
  console.log(`${verb} ${report.added.length}, amended ${report.amended.length}, ` +
    `unchanged ${report.unchanged}`);
  if (report.added.length) console.log(`  new: ${report.added.join(", ")}`);
  for (const { id, fields } of report.amended) {
    console.log(`  #${id}: ${fields.join(", ")}`);
  }

  if (report.failed.length) {
    console.log(`\nskipped ${report.failed.length} that would not replay:`);
    for (const { id, reason } of report.failed) console.log(`  #${id}: ${reason}`);
  }

  if (report.unwritten.length) {
    console.log(
      `\n${report.unwritten.length} puzzle(s) built but could NOT BE WRITTEN — nothing was saved:`,
    );
    for (const { id, reason } of report.unwritten) console.log(`  #${id}: ${reason}`);
    console.log(
      "\nThis is a database problem, not a puzzle problem. The commonest cause is the\n" +
        "activity server holding the write lock: run this when the server is idle, or\n" +
        "stop it first.",
    );
  }

  if (report.drifted.length) {
    console.log(
      `\n${report.drifted.length} PUBLISHED puzzle(s) have changed content on the sheet ` +
        "and were left alone:",
    );
    for (const { id, from, to } of report.drifted) {
      console.log(`  #${id}: ${from} -> ${to}`);
    }
    console.log(
      "\nA published puzzle's board, queue, hold, target or answer moving means the\n" +
        "sheet is now describing a different puzzle under an id somebody has already\n" +
        "played. Nothing here records what a past run was played on, so applying it\n" +
        "would re-file finished scores against a puzzle nobody saw. Either give the\n" +
        "new puzzle its own id on the sheet, or decide deliberately that the old\n" +
        "scores may be reattached.",
    );
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  const [codesCsv, metaCsv] = await Promise.all([
    readTab(options, CODES_SHEET),
    readTab(options, META_SHEET),
  ]);
  const codesById = indexById(parseCsv(codesCsv).slice(1));
  const metaById = indexById(parseCsv(metaCsv).slice(1));

  // Build everything BEFORE opening the database, let alone a transaction. The
  // replay is the slow part, and it needs no database at all.
  const report: Report = {
    added: [], amended: [], drifted: [], unchanged: 0, failed: [], unwritten: [],
  };
  const built: Puzzle[] = [];
  for (const [id, codes] of [...codesById].sort(([a], [b]) => a - b)) {
    if (!codes[1]) continue; // no puzzle blueprint: a metadata row, not a puzzle yet
    try {
      built.push(buildPuzzle(id, codes, metaById.get(id)));
    } catch (error) {
      report.failed.push({ id, reason: (error as Error).message });
    }
  }

  const db = new Database(options.db, { create: true });
  const now = Date.now();
  try {
    // Wait for the server rather than failing instantly. Nothing else in this
    // repository sets this, which is why a second writer normally dies on sight.
    db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    db.run(ARCHIVE_SCHEMA);

    db.transaction(() => {
      for (const puzzle of built) {
        try {
          record(report, puzzle.id, upsertArchive(db, puzzle, now));
        } catch (error) {
          // A write that fails is not a puzzle that will not replay.
          report.unwritten.push({ id: puzzle.id, reason: (error as Error).message });
        }
      }
      if (options.dryRun) throw new DryRun();
    })();
  } catch (error) {
    if (!(error instanceof DryRun)) throw error;
  } finally {
    db.close();
  }

  describe(report, options.dryRun);
  if (options.dryRun) console.log("\n--dry-run: nothing was written.");
  // A drift is a decision somebody has to make, and an unwritten row means the
  // sync did not do its job. Both are worth a non-zero exit for anything
  // running this on a schedule.
  if (report.drifted.length || report.unwritten.length) process.exitCode = 1;
}

/** Rolls a dry run's transaction back without pretending an error happened. */
class DryRun extends Error {}

if (import.meta.main) {
  await main();
}
