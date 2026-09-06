/**
 * A drag aimed while a direction key is held.
 *
 * The bug this pins: `PuzzleRun.input()` drops the plan whenever a key changes
 * state, which looks like enough — but it fires once per *physical* press and
 * deliberately ignores the OS repeat, while the engine's own DAS and ARR keep
 * shifting the piece on every tick for as long as the key stays down. So the
 * piece leaves the square the plan was walked from with no input the runner
 * ever sees, and the commit then plays a route computed for a position the
 * piece no longer occupies: the drag lands somewhere the preview never showed.
 *
 * It is the one thing this feature must not do, and it is reachable by anybody
 * who nudges the stack with a held key and then drags — which is the ordinary
 * way of playing.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { PuzzleRun } from "../client/src/game/runner";
import { decodeBoard, ENGINE_ROWS, type PuzzlePrompt } from "../shared/puzzle";
import { DEFAULT_HANDLING } from "../shared/tetris/handling";
import { pump, pumpUntil, resetHarness, SAFE_LOCK_FRAMES } from "./harness";

const PUZZLE: PuzzlePrompt = {
  id: 1, title: "stack", author: "test", difficulty: 1,
  goal: "place pieces", set: null, board: [],
  queue: ["O", "O", "O", "O", "O", "O"], hold: null, targetAttack: 4,
};

function newRun(): PuzzleRun {
  return new PuzzleRun(PUZZLE, DEFAULT_HANDLING, {
    onFrame: () => {}, onFinish: () => {}, onLock: () => {},
  });
}

/** Where the piece actually sits, as the engine has it. */
function pieceColumn(run: PuzzleRun): number {
  return (run as unknown as { engine: { falling: { location: number[] } } }).engine.falling.location[0]!;
}

beforeEach(() => {
  resetHarness();
});

describe("a plan outlives the piece it was made for", () => {
  /**
   * The order is the whole test. The planner is built lazily on the FIRST aim,
   * so drifting the piece *before* aiming proves nothing — the plan is simply
   * built fresh from wherever the piece ended up. The bug needs the aim first,
   * then the drift, then the commit.
   */
  test("a held direction key drifts the piece after the aim was taken", () => {
    const run = newRun();
    run.input("moveLeft", true);

    // Aim: the plan is walked from where the piece is now.
    run.aimAt({ column: 7, row: 0 });
    const aim = run.view().aim;
    expect(aim).not.toBeNull();
    const previewed = aim!.cells.map(([x, y]) => `${x},${y}`).sort();
    const columnAtAim = pieceColumn(run);

    // DAS/ARR now shifts the piece with no input the runner sees.
    pump(40);
    expect(pieceColumn(run)).not.toBe(columnAtAim);

    // Commit. The route must be the one that matches where the piece IS, not
    // the one walked from where it was when the finger went down.
    expect(run.placeAt()).toBe(true);
    pumpUntil(() => run.snapshot().piecesPlaced === 1);
    pump(SAFE_LOCK_FRAMES);
    run.input("moveLeft", false);

    const filled = new Set<string>();
    const board = run.view().cells;
    for (let y = 0; y < board.length; y++) {
      for (let x = 0; x < (board[y]?.length ?? 0); x++) {
        if (board[y]![x] !== null) filled.add(`${x},${y}`);
      }
    }
    for (const cell of previewed) {
      expect(filled.has(cell), `previewed ${cell} is empty — the piece landed elsewhere`).toBe(true);
    }
    run.dispose();
  });
});
