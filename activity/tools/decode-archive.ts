/**
 * Turning two spreadsheet rows into a verified `Puzzle`.
 *
 * Extracted from `build-puzzles.ts` unchanged, because a second caller needs it:
 * `sync-archive.ts` writes the same puzzles into the database instead of into a
 * file, and the two must agree exactly. `build-puzzles.ts` calls `main()` at
 * module scope and exported nothing, so importing from it would have run a
 * whole build as a side effect of asking for one function.
 *
 * The important thing this module owns is the verification, not the decoding:
 * `buildPuzzle` replays the author's answer through the real engine and takes
 * what it actually sends as the puzzle's target. A puzzle whose answer will not
 * replay throws here, and a puzzle with no verified target is one nobody can be
 * scored against. Both callers depend on that throw.
 *
 * **Columns are read by position, not by header name.** That is inherited
 * rather than chosen — a column inserted into either tab shifts every field
 * after it, silently. The indices each function reads are named in its comment
 * so the damage is at least greppable.
 */

import { decodeBlueprint } from "../shared/blueprint/decode";
import { pieceCells, type Playfield } from "../shared/blueprint/playfield";
import {
  type BoardCell,
  encodeBoard,
  type Mino,
  type Puzzle,
  requirementFromSolution,
  type SolutionStep,
} from "../shared/puzzle";
import { DEFAULT_HANDLING } from "../shared/tetris/handling";
import { replayPlacements } from "../shared/tetris/replay";
import { alignPlacements } from "./align-placements";

/** The tab holding the blueprint code pair. Columns: 0 id, 1 puzzle, 2 answer, 4 title. */
export const CODES_SHEET = "Copy of Puzzles Archive - blueprint urls.csv";
/**
 * The tab holding the metadata.
 * Columns: 0 id, 1 title, 2 difficulty, 3 creator, 4 creation date, 7 set,
 * 8 solve count.
 */
export const META_SHEET = "Copy of Puzzles Archive - Puzzles.csv";

/** Row lookup keyed by puzzle id, tolerating the archive's stray whitespace. */
export function indexById(rows: string[][]): Map<number, string[]> {
  const byId = new Map<number, string[]>();
  for (const row of rows) {
    const id = Number.parseInt(row[0]?.trim() ?? "", 10);
    if (Number.isFinite(id)) byId.set(id, row.map((cell) => cell.trim()));
  }
  return byId;
}

export function toBoardCells(playfield: Playfield): BoardCell[][] {
  return playfield.toRows(playfield.stackHeight).map((row) =>
    row.map((cell) => {
      if (cell === null) return null;
      // 'u' marks the wall outside the field and never appears inside a puzzle.
      return cell === "g" ? "G" : cell === "u" ? null : (cell as Mino);
    }),
  );
}

export interface DecodedPosition {
  board: BoardCell[][];
  queue: Mino[];
  hold: Mino | null;
  goal: string;
}

export function decodePosition(code: string): DecodedPosition {
  const page = decodeBlueprint(code).pages[0];
  if (!page) throw new Error("Blueprint decoded to no pages");
  if (!page.piece) throw new Error("Position has no active piece to start from");
  return {
    board: toBoardCells(page.playfield),
    queue: [page.piece.type, ...page.queue.previews],
    hold: page.queue.hold,
    goal: page.comment.trim(),
  };
}

/** Only locked pages are placements; the rest are editor snapshots. */
export function decodeAnswerPlacements(code: string) {
  return decodeBlueprint(code)
    .pages.filter((page) => page.locked && page.piece !== null)
    .map((page) => ({
      piece: page.piece!.type,
      cells: pieceCells(page.piece!).map(({ x, y }) => [x, y] as const),
    }));
}

export interface BuildFailure {
  id: number;
  reason: string;
}

export function buildPuzzle(
  id: number,
  codes: string[],
  meta: string[] | undefined,
): Puzzle {
  const position = decodePosition(codes[1] ?? "");
  const answerCode = codes[2] ?? "";
  if (!answerCode) throw new Error("No answer blueprint on file");

  const recorded = decodeAnswerPlacements(answerCode);
  if (recorded.length === 0) throw new Error("Answer blueprint places no pieces");
  const placements = alignPlacements(recorded, position.queue, position.hold);
  if (placements.length === 0) {
    throw new Error("No placement in the answer can be reached with the puzzle's pieces");
  }

  const setup = { board: position.board, queue: position.queue, hold: position.hold };
  const replay = replayPlacements(setup, DEFAULT_HANDLING, placements);
  if (replay.totalAttack === 0) throw new Error("Answer sends no attack — nothing to score");

  const solution: SolutionStep[] = replay.steps.map((step) => ({
    piece: step.piece,
    cells: step.cells.map(([x, y]) => [x, y] as const),
    clear: step.clear,
    attack: step.attack,
  }));

  const difficulty = Number.parseFloat(meta?.[2] ?? "");
  return {
    id,
    title: (meta?.[1] || codes[4] || `Puzzle ${id}`).trim(),
    author: (meta?.[3] || "unknown").trim(),
    difficulty: Number.isFinite(difficulty) ? difficulty : 0,
    goal: position.goal,
    set: meta?.[7]?.trim() || null,
    board: encodeBoard(position.board),
    queue: position.queue,
    hold: position.hold,
    targetAttack: replay.totalAttack,
    // Read off the replay that just happened, which is the club's rule: the
    // maker's title and goal stay as written, and what is enforced is what their
    // own answer does. Derived here rather than by a later pass so every
    // consumer of a built puzzle — the sheet sync, the JSON build, the audit —
    // sees the same rule without joining across files by id.
    requiredClears: requirementFromSolution(solution),
    solution,
    source: { puzzle: codes[1] ?? "", solution: answerCode },
  };
}

/** Archive bookkeeping off the metadata tab: not gameplay, but the club's record. */
export interface ArchiveMeta {
  /** The sheet's creation date, as written. Null when the cell is empty. */
  readonly addedOn: string | null;
  /** The club's recorded solve count. Null when absent or unparseable. */
  readonly solveCount: number | null;
}

/**
 * The sheet writes dates as `M/D/YY`. Everything downstream wants one format,
 * and the website already stores ISO, so the normalising happens once here
 * rather than in each consumer. Anything that does not parse is passed through
 * untouched rather than guessed at — a date nobody can read is better than a
 * date read wrongly.
 */
function toIsoDate(raw: string): string {
  const parts = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(raw);
  if (!parts) return raw;
  const [, month, day, year] = parts;
  const full = year!.length === 2 ? `20${year}` : year!;
  return `${full}-${month!.padStart(2, "0")}-${day!.padStart(2, "0")}`;
}

/** Reads columns 4 and 8, which `buildPuzzle` has no use for. */
export function archiveMetaOf(meta: string[] | undefined): ArchiveMeta {
  const added = meta?.[4]?.trim();
  const solves = Number.parseInt(meta?.[8]?.trim() ?? "", 10);
  return {
    addedOn: added ? toIsoDate(added) : null,
    solveCount: Number.isFinite(solves) ? solves : null,
  };
}
