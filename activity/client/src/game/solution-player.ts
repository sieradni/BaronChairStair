/**
 * Steps through the reference solution after a run.
 *
 * Rebuilds the board placement by placement rather than storing twenty board
 * snapshots per puzzle: the archive already ships the squares each piece
 * occupies, and locking them is four lines of work.
 */

import {
  BOARD_WIDTH,
  type BoardCell,
  decodeBoard,
  ENGINE_ROWS,
  type PuzzlePrompt,
  type SolutionStep,
} from "@shared/puzzle";
import type { BoardView } from "../render/board";
import { MINO_INK } from "../render/skin";

function lockCells(
  board: readonly (readonly BoardCell[])[],
  cells: readonly (readonly [number, number])[],
  piece: BoardCell,
): BoardCell[][] {
  const next = board.map((row) => [...row]);
  for (const [x, y] of cells) {
    const row = next[y];
    if (row) row[x] = piece;
  }
  const kept = next.filter((row) => row.some((cell) => cell === null));
  while (kept.length < next.length) kept.push(Array<BoardCell>(BOARD_WIDTH).fill(null));
  return kept;
}

export class SolutionPlayer {
  private index = 0;
  private boards: BoardCell[][][];

  constructor(
    /**
     * Only the starting board is read, and the type now says so.
     *
     * It was the whole `PuzzlePrompt` while the reveal at the end of a run was
     * the only caller and one was always to hand. The review page steps a
     * *submission*, which has no id, no rating and no archive target — and
     * inventing those to satisfy a parameter this class never looks at would
     * put a puzzle-shaped object that is not a puzzle into the one place a
     * reviewer decides whether it should become one.
     */
    prompt: Pick<PuzzlePrompt, "board">,
    private readonly steps: readonly SolutionStep[],
    readonly visibleRows: number,
  ) {
    let board = decodeBoard(prompt.board, ENGINE_ROWS);
    this.boards = [board];
    for (const step of steps) {
      board = lockCells(board, step.cells, step.piece);
      this.boards.push(board);
    }
  }

  get stepCount(): number {
    return this.steps.length;
  }

  /**
   * The board once every placement has been made.
   *
   * What a solution *leaves behind* is the one picture that distinguishes two
   * lines at a glance — which is what the gallery's previews need, and why this
   * is a getter rather than something the caller reconstructs by stepping to
   * the end and reading `view()`.
   */
  get finalBoard(): readonly (readonly BoardCell[])[] {
    return this.boards[this.boards.length - 1] ?? this.boards[0]!;
  }

  get position(): number {
    return this.index;
  }

  get current(): SolutionStep | null {
    return this.steps[this.index] ?? null;
  }

  /** Every placement, so a timeline can mark the ones that clear lines. */
  get placements(): readonly SolutionStep[] {
    return this.steps;
  }

  /** Whether the last placement has been made and there is nothing left to show. */
  get atEnd(): boolean {
    return this.index >= this.steps.length;
  }

  next(): void {
    this.index = Math.min(this.steps.length, this.index + 1);
  }

  previous(): void {
    this.index = Math.max(0, this.index - 1);
  }

  /**
   * Jumps straight to a placement.
   *
   * The whole point of a timeline: reading a seventy-piece solution by pressing
   * ▶ seventy times is not reading it. Clamped rather than validated because a
   * scrubbed position comes from a pointer and being one past the end is
   * ordinary, not a mistake.
   */
  seek(index: number): void {
    this.index = Math.max(0, Math.min(this.steps.length, Math.round(index)));
  }

  reset(): void {
    this.index = 0;
  }

  end(): void {
    this.index = this.steps.length;
  }

  /**
   * The board before the current step, with that step's piece drawn on top —
   * and the step after it as a ghost.
   *
   * The ghost is the part worth explaining. A solution read one placement at a
   * time tells you *what* happened and never *why*: the T that looks arbitrary
   * on step four is obvious the moment you can see the I that follows it. So
   * the next placement is drawn the way the game already draws a landing
   * preview — a wash of its own colour inside an outline — one move ahead of
   * where you are.
   *
   * Its own ink, not the current piece's: two pieces of the same colour would
   * be a lie about which is which, and `ghostInk` exists on `BoardView` for
   * exactly this.
   */
  view(): BoardView {
    const step = this.steps[this.index];
    const upcoming = this.steps[this.index + 1];
    return {
      cells: this.boards[this.index] ?? this.boards[0]!,
      visibleRows: this.visibleRows,
      active: step ? step.cells : [],
      activeInk: step ? MINO_INK[step.piece] : null,
      ghost: upcoming ? upcoming.cells : [],
      ghostInk: upcoming ? MINO_INK[upcoming.piece] : null,
      // No flash. A replay is read a step at a time rather than watched, so a
      // clear highlight is a permanent wash across rows the reader is trying to
      // look through — it is drawn on every frame the step is on screen, not
      // for a moment like the one a live run shows. The caption says what the
      // placement cleared.
      flashRows: [],
      flashStrength: 0,
      dimmed: false,
      aim: null,
    };
  }
}
