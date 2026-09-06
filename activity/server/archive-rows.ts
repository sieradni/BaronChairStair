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
 * **Content may not change under a published id.** See {@link upsertArchive}.
 */

import type { Database } from "bun:sqlite";
import type { ClearRequirement, Mino, Puzzle, RowCode, SolutionStep } from "../shared/puzzle";
import { COMMUNITY_ID_BASE } from "../shared/puzzle";

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
 * correction and should flow through freely. Board, queue, hold, target and
 * answer are the puzzle itself, and a change to any of them under a published
 * id means somebody's recorded score is filed against something they never saw.
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
   * The puzzle itself moved under a published id, and the row was left alone.
   * See {@link upsertArchive} for why this is refused rather than applied.
   */
  | { kind: "drifted"; from: string; to: string };

const METADATA_FIELDS = ["title", "author", "difficulty", "goal", "set"] as const;

function movedMetadata(before: Puzzle, after: Puzzle): string[] {
  return METADATA_FIELDS.filter((field) => before[field] !== after[field]);
}

/**
 * Write one decoded puzzle into the archive.
 *
 * The rule worth stating: **a published puzzle's content is immutable here.**
 * If the sheet now decodes id 8 into a different board, this refuses and
 * reports `drifted` rather than overwriting. Nothing in the database records
 * what a past run was actually played on — `runs` and `day_puzzles` both
 * reference a puzzle by id alone — so overwriting silently re-files finished
 * scores against a puzzle nobody played. Refusing is recoverable; overwriting
 * is not.
 *
 * Metadata is not content and flows through freely, including on published
 * rows: a corrected title or a filled-in difficulty rating is the sheet being
 * fixed, and holding those back would give officers a reason to want the
 * content check turned off.
 *
 * `requiredClears` is set once, on insert, and then never rewritten — the
 * UPDATE below does not touch the column. That is the reason `db.ts` gives on
 * it: the requirement is a decision somebody made about what a goal means, not
 * a fact about the board, and a re-sync re-deriving it would quietly
 * un-enforce it.
 */
export function upsertArchive(db: Database, puzzle: Puzzle, now: number): SyncOutcome {
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
  if (contentMoved && existing.publishedAt !== null) {
    return { kind: "drifted", from: existing.contentHash, to: incoming };
  }

  const fields = movedMetadata(existing.puzzle, puzzle);
  if (!contentMoved && fields.length === 0) return { kind: "unchanged" };

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
  return contentMoved
    ? { kind: "amended", fields: [...fields, "content"] }
    : { kind: "amended", fields };
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
