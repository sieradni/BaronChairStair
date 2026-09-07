/**
 * The club's puzzle archive, as rows.
 *
 * The table is declared in `db.ts`; the reasoning that decides these queries is
 * here. Three rules shape every function below.
 *
 * **A synced row is not playable.** `sync-archive.ts` writes rows with
 * `published_at` NULL, and only {@link publishArchive} sets it. That is the
 * replacement for the review gate the archive used to get from git: a new
 * puzzle used to arrive as a diff in a tracked JSON file that somebody
 * approved, and a database write has no such gate on its own.
 *
 * **The boot read filters in SQL.** {@link readPublishedArchive} is the only
 * thing that feeds `PuzzleArchive.load`, and it excludes unpublished rows in
 * the `WHERE` clause rather than with a `.filter()` afterwards. `load` runs at
 * module scope and throws on a malformed puzzle, so a bad row that reaches it
 * takes the whole server down at boot, for every player, with no HTTP route
 * left to fix it from.
 *
 * **A content change is applied, but never silent.** A creator may go back and
 * edit their own puzzle, so the row is rewritten. What that costs is recorded
 * rather than prevented: the previous content goes to `archive_content_log`,
 * and the change comes back as its own outcome so the sync can report it.
 * Publication survives an edit — the UPDATE does not touch `published_at`.
 */

import type { Database } from "bun:sqlite";
import type { ClearRequirement, Mino, Puzzle, RowCode, SolutionStep } from "../shared/puzzle";
import { clearShortfall, COMMUNITY_ID_BASE } from "../shared/puzzle";

const COLUMNS = `
  id, title, author, difficulty, goal, set_name, board, queue, hold,
  target_attack, solution, required_clears, source_puzzle, source_solution,
  content_hash, synced_at, published_at, published_by
`;

interface ArchiveRow {
  id: number;
  title: string;
  author: string;
  difficulty: number;
  goal: string;
  set_name: string | null;
  board: string;
  queue: string;
  hold: string | null;
  target_attack: number;
  solution: string;
  required_clears: string | null;
  source_puzzle: string;
  source_solution: string;
  content_hash: string;
  synced_at: number;
  published_at: number | null;
  published_by: string | null;
}

/** A row's publication state, for the review tool and the sync report. */
export interface ArchiveEntry {
  readonly puzzle: Puzzle;
  readonly contentHash: string;
  readonly syncedAt: number;
  readonly publishedAt: number | null;
  readonly publishedBy: string | null;
}

/**
 * Fingerprint of the fields that decide how a puzzle *plays*.
 *
 * Deliberately not the whole puzzle: a title fix or a difficulty rating is a
 * correction, and the puzzle it names is still the puzzle people played. Board,
 * queue, hold, target and answer are the puzzle itself.
 *
 * The hash no longer decides whether a write happens — it decides what the
 * write is called. It is what separates "the sheet fixed a typo" from "the
 * sheet replaced the puzzle", and a change to any of these under a published id
 * means somebody's recorded score is filed against something they never saw.
 *
 * Not a cryptographic hash and does not need to be — it compares a row against
 * its own previous value, and nobody is choosing the input adversarially.
 */
export function contentHash(puzzle: Puzzle): string {
  const shape = JSON.stringify([
    puzzle.board,
    puzzle.queue,
    puzzle.hold,
    puzzle.targetAttack,
    puzzle.solution ?? null,
  ]);
  let hash = 0x811c9dc5;
  for (let i = 0; i < shape.length; i += 1) {
    hash ^= shape.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function toPuzzle(row: ArchiveRow): Puzzle {
  const requiredClears = row.required_clears
    ? (JSON.parse(row.required_clears) as ClearRequirement[])
    : undefined;
  return {
    id: row.id,
    title: row.title,
    author: row.author,
    difficulty: row.difficulty,
    goal: row.goal,
    set: row.set_name,
    board: JSON.parse(row.board) as RowCode[],
    queue: JSON.parse(row.queue) as Mino[],
    hold: row.hold as Mino | null,
    targetAttack: row.target_attack,
    ...(requiredClears ? { requiredClears } : {}),
    solution: JSON.parse(row.solution) as SolutionStep[],
    source: { puzzle: row.source_puzzle, solution: row.source_solution },
  };
}

function toEntry(row: ArchiveRow): ArchiveEntry {
  return {
    puzzle: toPuzzle(row),
    contentHash: row.content_hash,
    syncedAt: row.synced_at,
    publishedAt: row.published_at,
    publishedBy: row.published_by,
  };
}

/**
 * What players may be served. The archive's boot read, and the only one.
 *
 * `ORDER BY id` rather than insertion order because the rotation is a function
 * of the pool's *position*, and a pool that reorders itself between restarts
 * would move which puzzle each future day draws for no visible reason.
 */
export function readPublishedArchive(db: Database): Puzzle[] {
  return db
    .query<ArchiveRow, []>(
      `SELECT ${COLUMNS} FROM archive_puzzles
        WHERE published_at IS NOT NULL
        ORDER BY id ASC`,
    )
    .all()
    .map(toPuzzle);
}

/** Everything synced but not yet published — the officer's queue. */
export function pendingArchive(db: Database): ArchiveEntry[] {
  return db
    .query<ArchiveRow, []>(
      `SELECT ${COLUMNS} FROM archive_puzzles
        WHERE published_at IS NULL
        ORDER BY id ASC`,
    )
    .all()
    .map(toEntry);
}

export function archiveEntry(db: Database, id: number): ArchiveEntry | null {
  const row = db
    .query<ArchiveRow, [number]>(`SELECT ${COLUMNS} FROM archive_puzzles WHERE id = ?1`)
    .get(id);
  return row ? toEntry(row) : null;
}

/** What {@link upsertArchive} did with one puzzle. */
export type SyncOutcome =
  /** New id. Written, unpublished. */
  | { kind: "added" }
  /** Already on file, byte for byte. Nothing written. */
  | { kind: "unchanged" }
  /** Metadata moved — title, author, difficulty, set, goal. Written. */
  | { kind: "amended"; fields: readonly string[] }
  /**
   * The puzzle itself moved under an id somebody has already been able to play,
   * and the change was applied. The one outcome an officer has to see: it is
   * the moment a finished score stopped describing the puzzle it was set on.
   */
  | {
      kind: "edited";
      fields: readonly string[];
      from: string;
      to: string;
      /** Set when the frozen clear requirement no longer fits the new answer. */
      droppedClears: readonly ClearRequirement[] | null;
      /** Runs already filed against this id, or null if this database has none. */
      runsBefore: number | null;
      /** Discovered lines voided by the edit, or null if there was no table. */
      solutionsVoided: number | null;
    };

const METADATA_FIELDS = ["title", "author", "difficulty", "goal", "set"] as const;

function movedMetadata(before: Puzzle, after: Puzzle): string[] {
  return METADATA_FIELDS.filter((field) => before[field] !== after[field]);
}

/**
 * How many runs are already filed against a puzzle, or null when this database
 * has no `runs` table at all.
 *
 * The null matters: `tools/sync-archive.ts` deliberately creates only
 * {@link ARCHIVE_SCHEMA}, so a sync against a fresh or archive-only database
 * has no player tables. An unguarded COUNT would throw there and be reported as
 * a failed write, which is the opposite of the truth — there is simply nobody
 * to affect.
 */
export function runsAgainst(db: Database, puzzleId: number): number | null {
  const present = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runs'",
    )
    .get();
  if (!present) return null;
  return (
    db
      .query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM runs WHERE puzzle_id = ?1")
      .get(puzzleId)?.n ?? 0
  );
}

/**
 * Deletes every discovered solution filed against a puzzle. Returns how many,
 * or null when this database has no `puzzle_solutions` table.
 *
 * A discovered line is a claim about a board — "this sequence of placements
 * solves this position". When the board changes the claim is void, and nothing
 * in the discovery system can tell: `solutionFingerprint` is placements, attack
 * and clear names with no board in it, so the rows keep matching and no code
 * path anywhere re-validates them.
 *
 * Left alone they do active harm rather than merely going stale. They are shown
 * to makers as the evidence for "is my clear requirement too loose", they
 * inflate the line counts on the review tool's archive tab, and the unique
 * index on (puzzle_id, canonical_key) means the next player to genuinely find
 * one of those lines on the *new* board is refused credit as a duplicate.
 */
export function voidDiscoveries(db: Database, puzzleId: number): number | null {
  const present = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'puzzle_solutions'",
    )
    .get();
  if (!present) return null;
  db.run("DELETE FROM puzzle_solutions WHERE puzzle_id = ?1", [puzzleId]);
  return db.query<{ changes: number }, []>("SELECT changes() AS changes").get()?.changes ?? 0;
}

/**
 * Records what a puzzle was, immediately before it stops being that.
 *
 * Values rather than the hash, because the hash proves a change happened and
 * tells nobody what changed. Runs in the caller's transaction, so a logged
 * change and the change itself cannot come apart.
 */
function logContentChange(
  db: Database,
  was: ArchiveEntry,
  becameHash: string,
  runsBefore: number | null,
  solutionsVoided: number | null,
  at: number,
  by: string,
): void {
  const puzzle = was.puzzle;
  db.run(
    `INSERT INTO archive_content_log
       (puzzle_id, was_hash, became_hash, was_board, was_queue, was_hold, was_target,
        was_solution, was_clears, was_published, runs_before, solutions_voided, at, by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
    [
      puzzle.id,
      was.contentHash,
      becameHash,
      JSON.stringify(puzzle.board),
      JSON.stringify(puzzle.queue),
      puzzle.hold,
      puzzle.targetAttack,
      JSON.stringify(puzzle.solution ?? []),
      puzzle.requiredClears ? JSON.stringify(puzzle.requiredClears) : null,
      was.publishedAt === null ? 0 : 1,
      runsBefore,
      solutionsVoided,
      at,
      by,
    ],
  );
}

/** Every content change ever made to one puzzle, oldest first. */
export function contentHistory(db: Database, puzzleId: number): ContentChange[] {
  return db
    .query<ContentLogRow, [number]>(
      `SELECT entry_id, puzzle_id, was_hash, became_hash, was_target, was_clears,
              was_published, runs_before, solutions_voided, at, by
         FROM archive_content_log WHERE puzzle_id = ?1 ORDER BY entry_id ASC`,
    )
    .all(puzzleId)
    .map((row) => ({
      entryId: row.entry_id,
      puzzleId: row.puzzle_id,
      wasHash: row.was_hash,
      becameHash: row.became_hash,
      wasTarget: row.was_target,
      wasClears: row.was_clears ? (JSON.parse(row.was_clears) as ClearRequirement[]) : null,
      wasPublished: row.was_published === 1,
      runsBefore: row.runs_before,
      solutionsVoided: row.solutions_voided,
      at: row.at,
      by: row.by,
    }));
}

interface ContentLogRow {
  entry_id: number;
  puzzle_id: number;
  was_hash: string;
  became_hash: string;
  was_target: number;
  was_clears: string | null;
  was_published: number;
  runs_before: number | null;
  solutions_voided: number | null;
  at: number;
  by: string;
}

/** One entry from {@link contentHistory}. */
export interface ContentChange {
  readonly entryId: number;
  readonly puzzleId: number;
  readonly wasHash: string;
  readonly becameHash: string;
  readonly wasTarget: number;
  readonly wasClears: readonly ClearRequirement[] | null;
  readonly wasPublished: boolean;
  readonly runsBefore: number | null;
  /** Discovered lines deleted by this change; null if there was no table. */
  readonly solutionsVoided: number | null;
  readonly at: number;
  readonly by: string;
}

/**
 * Write one decoded puzzle into the archive.
 *
 * **A creator may edit a published puzzle, so an edit is applied.** If the
 * sheet now decodes id 8 into a different board, that board is written.
 *
 * What that costs, stated precisely, because a vaguer version of it was wrong:
 * existing scores do not change. Every `runs` row stores the `target_attack` it
 * was judged against and no leaderboard or streak query reads a puzzle table,
 * so no rank, time or solved flag moves. What moves is what those rows are
 * *about* — `runs` and `day_puzzles` reference a puzzle by id and keep no copy
 * of the board, so a finished score now points at content nobody played it on.
 *
 * Overwriting is not recoverable, so the previous content is written to
 * `archive_content_log` first, in the caller's transaction. That is the whole
 * of what makes an already-filed score interpretable afterwards.
 *
 * Discovered alternate solutions are **voided** by an edit — see
 * {@link voidDiscoveries}. They are claims about a board, and the board has
 * moved; keeping them would deny the next genuine discoverer their credit.
 *
 * Metadata is not content and flows through freely, including on published
 * rows: a corrected title or a filled-in difficulty rating is the sheet being
 * fixed, and holding those back would give officers a reason to want the
 * content check turned off.
 *
 * `requiredClears` survives a metadata correction untouched, for the reason
 * `db.ts` gives on the column: the requirement is a decision somebody made
 * about what a goal means, not a fact about the board.
 *
 * It cannot survive a *content* edit unexamined. A requirement frozen against
 * the old answer, left bolted to a new board, is enforced by
 * `solvedUnderPolicy` and can demand a clear the new answer never makes —
 * which is exactly the unsolvable puzzle `tools/audit-archive.ts` exists to
 * catch. So on a content edit the incoming answer is checked against it: kept
 * when it still holds, dropped and reported when it does not. Dropping
 * un-enforces a goal until an officer re-freezes it, which is recoverable; the
 * alternative is a published puzzle nobody can solve, which is not.
 */
export function upsertArchive(
  db: Database,
  puzzle: Puzzle,
  now: number,
  by = "sync-archive",
): SyncOutcome {
  if (puzzle.id <= 0 || puzzle.id >= COMMUNITY_ID_BASE) {
    throw new RangeError(
      `Puzzle ${puzzle.id} is outside the club band (1..${COMMUNITY_ID_BASE - 1}). ` +
        "The community band is the only record of where a puzzle came from.",
    );
  }

  const existing = archiveEntry(db, puzzle.id);
  const incoming = contentHash(puzzle);

  if (!existing) {
    db.run(
      `INSERT INTO archive_puzzles (${COLUMNS})
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, NULL, NULL)`,
      [
        puzzle.id,
        puzzle.title,
        puzzle.author,
        puzzle.difficulty,
        puzzle.goal,
        puzzle.set,
        JSON.stringify(puzzle.board),
        JSON.stringify(puzzle.queue),
        puzzle.hold,
        puzzle.targetAttack,
        JSON.stringify(puzzle.solution ?? []),
        puzzle.requiredClears ? JSON.stringify(puzzle.requiredClears) : null,
        puzzle.source?.puzzle ?? "",
        puzzle.source?.solution ?? "",
        incoming,
        now,
      ],
    );
    return { kind: "added" };
  }

  const contentMoved = existing.contentHash !== incoming;
  const fields = movedMetadata(existing.puzzle, puzzle);
  if (!contentMoved && fields.length === 0) return { kind: "unchanged" };

  // Everything below has to be decided BEFORE the UPDATE: it is the write that
  // destroys the evidence.
  let droppedClears: readonly ClearRequirement[] | null = null;
  let runsBefore: number | null = null;
  let solutionsVoided: number | null = null;
  if (contentMoved) {
    runsBefore = runsAgainst(db, puzzle.id);
    // Before the log, so the log can record how many went.
    solutionsVoided = voidDiscoveries(db, puzzle.id);
    logContentChange(db, existing, incoming, runsBefore, solutionsVoided, now, by);

    const frozen = existing.puzzle.requiredClears;
    const made = (puzzle.solution ?? [])
      .map((step) => step.clear)
      .filter((clear): clear is NonNullable<typeof clear> => Boolean(clear));
    if (frozen?.length && clearShortfall(made, frozen).length > 0) {
      droppedClears = frozen;
      db.run("UPDATE archive_puzzles SET required_clears = NULL WHERE id = ?1", [puzzle.id]);
    }
  }

  db.run(
    `UPDATE archive_puzzles
        SET title = ?2, author = ?3, difficulty = ?4, goal = ?5, set_name = ?6,
            board = ?7, queue = ?8, hold = ?9, target_attack = ?10,
            solution = ?11, source_puzzle = ?12, source_solution = ?13,
            content_hash = ?14, synced_at = ?15
      WHERE id = ?1`,
    [
      puzzle.id,
      puzzle.title,
      puzzle.author,
      puzzle.difficulty,
      puzzle.goal,
      puzzle.set,
      JSON.stringify(puzzle.board),
      JSON.stringify(puzzle.queue),
      puzzle.hold,
      puzzle.targetAttack,
      JSON.stringify(puzzle.solution ?? []),
      puzzle.source?.puzzle ?? "",
      puzzle.source?.solution ?? "",
      incoming,
      now,
    ],
  );
  if (!contentMoved) return { kind: "amended", fields };
  if (existing.publishedAt === null) {
    // Not playable yet, so nobody can have a score against the old content.
    return { kind: "amended", fields: [...fields, "content"] };
  }
  return {
    kind: "edited",
    fields,
    from: existing.contentHash,
    to: incoming,
    droppedClears,
    runsBefore,
    solutionsVoided,
  };
}

/**
 * Publish rows, making them playable at the next restart.
 *
 * Bulk by design. The rotation is a pure function of the pool's *length*, so
 * every publish changes which puzzle every future day draws; publishing a few
 * rows at a time churns tomorrow's puzzle once per click. One deliberate call
 * moves the pool once.
 *
 * Returns the ids it actually changed, not a count: two officers can hold
 * review links at the same time and nothing coordinates them, so a second
 * caller publishing the same ids must be able to tell that it did nothing.
 */
export function publishArchive(
  db: Database,
  ids: readonly number[],
  publishedBy: string,
  now: number,
): number[] {
  if (ids.length === 0) return [];
  const published: number[] = [];
  db.transaction(() => {
    const update = db.query<unknown, [number, number, string]>(
      `UPDATE archive_puzzles SET published_at = ?2, published_by = ?3
        WHERE id = ?1 AND published_at IS NULL`,
    );
    for (const id of ids) {
      update.run(id, now, publishedBy);
      if (db.query<{ changes: number }, []>("SELECT changes() AS changes").get()?.changes) {
        published.push(id);
      }
    }
  })();
  return published;
}

/** How many rows are on file, published and not. For the sync report. */
export function archiveCounts(db: Database): { published: number; pending: number } {
  const row = db
    .query<{ published: number; pending: number }, []>(
      `SELECT
         COUNT(*) FILTER (WHERE published_at IS NOT NULL) AS published,
         COUNT(*) FILTER (WHERE published_at IS NULL)     AS pending
       FROM archive_puzzles`,
    )
    .get();
  return row ?? { published: 0, pending: 0 };
}
