/**
 * The slam: a fast downward flick hard-drops the virtual position.
 *
 * The unit tests in pointer.test.ts pin the gesture half (direction,
 * threshold, timing); these pin the run half against the real puzzle
 * geometry — the seat the slam commits is the preview descended to rest,
 * the log the server would replay is byte-shaped like any drag commit,
 * and a flick with nowhere to go spends nothing.
 */

import { describe, expect, test } from "bun:test";
import { PuzzleRun } from "../client/src/game/runner";
import { DEFAULT_HANDLING } from "../shared/tetris/handling";
import { verifyRun } from "../shared/tetris/verify";
import { decodeBoard, ENGINE_ROWS, type PuzzlePrompt } from "../shared/puzzle";
import { resetHarness, pump, pumpUntil } from "./harness";

const sorted = (cells: readonly (readonly [number, number])[]) =>
  cells.map(([x, y]) => [x, y] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1]);

const PUZZLE: PuzzlePrompt = {
  id: 37,
  title: "spin tutorial 1",
  author: "satilea",
  difficulty: 2,
  goal: "Clear a TSD",
  set: "spin fills",
  board: ["G.....GGGG", "G......GGG", "G.J...GGGG", "JJJ......."],
  queue: ["L", "S", "T"],
  hold: null,
  targetAttack: 4,
};

function newRun(): PuzzleRun {
  return new PuzzleRun(PUZZLE, DEFAULT_HANDLING, {
    onFrame: () => {},
    onFinish: () => {},
    onLock: () => {},
  });
}

describe("the slam", () => {
  resetHarness();

  test("a flick at the shadow seat commits at once", () => {
    const run = newRun();
    run.grabBase();
    run.carryAt({ column: 0, row: 0 }); // the shadow: the L's bar on the well floor
    expect(run.view().aim?.legal).toBe(true);
    run.slamDrop();
    // No rest, no release: the piece is spent in the same instant.
    expect(run.snapshot().piecesPlaced).toBe(1);
    run.dispose();
  });

  test("a swipe from a floating preview descends the seat it shows to rest", () => {
    const run = newRun();
    run.grabBase();
    run.carryAt({ column: 0, row: 0 });
    const anchor = sorted(run.view().aim!.cells);
    run.carryAt({ column: 0, row: 3 }); // carried up: floating over the well, illegal as shown
    expect(run.view().aim?.legal).toBe(false);
    const before = run.view().cells;
    // The drop takes the floated seat and descends it the way a hard drop
    // descends a piece — down until the row below is occupied — which lands
    // it exactly on the shadow it was floating above. A mid-air seat the
    // player cannot place by releasing still gets its hard drop.
    run.slamDrop();
    expect(run.snapshot().piecesPlaced).toBe(1);
    const added = sorted(
      run.view().cells.flatMap((row, y) =>
        row.map((cell, x) =>
          cell && !before[y]?.[x] ? ([x, y] as const) : null,
        ).filter((c): c is readonly [number, number] => c !== null),
      ),
    );
    expect(added).toEqual(anchor);
    run.dispose();
  });

  test("a swipe at a seat inside the stack is a settled nothing", () => {
    const run = newRun();
    run.grabBase();
    run.carryAt({ column: -3, row: 3 }); // floating over the J stack: buried
    run.settleAt(); // released unplaceable: the seat parks, dashed
    const parked = sorted(run.view().aim!.cells);
    run.grabBase(); // the drag re-anchors on the park
    run.carryAt({ column: 0, row: 0 }); // zero travel: the park's own seat, shown
    run.slamDrop();
    // The seat is inside the stack. A hard drop asks whether the piece fits
    // where it is before it asks about the row below, and a piece already
    // overlapping the stack is not somewhere anything can be dropped from:
    // the swipe spends nothing. (The park's re-commit path is the rest gate
    // or a carry to a legal seat, never the swipe.)
    expect(run.snapshot().piecesPlaced).toBe(0);
    expect(run.log()).toEqual([]);
    expect(sorted(run.view().aim!.cells)).toEqual(parked); // still the player's
    run.dispose();
  });

  test("a swipe with the preview off the board spends nothing", () => {
    const run = newRun();
    run.grabBase();
    run.carryAt({ column: 9, row: 0 }); // carried off the right edge: no preview
    expect(run.view().aim).toBeNull();
    run.slamDrop();
    // No seat on screen, no drop: a stroke that ended past the edge names
    // nothing to take, and guessing at the columns it passed through would
    // be inventing a placement the player never saw.
    expect(run.snapshot().piecesPlaced).toBe(0);
    expect(run.log()).toEqual([]);
    run.dispose();
  });

  test("a keyboard rotation mid-stroke rides along: the swipe takes the shown seat", () => {
    // A keyboard can rotate a drag in flight (a touch cannot), and the key
    // goes through {@link input} — not the pointer's own tap — so this is the
    // path a mouse-and-keyboard player takes. The seat stays where the player
    // arranged it and turns in place; the swipe then takes the seat on screen,
    // in the orientation it is shown.
    const run = newRun();
    run.grabBase();
    run.carryAt({ column: 0, row: 0 });
    const arranged = sorted(run.view().aim!.cells);
    run.input("rotateCW", true);
    run.input("rotateCW", false);
    const shown = sorted(run.view().aim!.cells);
    expect(shown.length).toBe(4); // the seat is still there, turned in place
    expect([...shown].sort()).not.toEqual([...arranged].sort()); // and it IS turned
    const before = run.view().cells;
    run.slamDrop();
    expect(run.snapshot().piecesPlaced).toBe(1);
    const added = sorted(
      run.view().cells.flatMap((row, y) =>
        row.map((cell, x) =>
          cell && !before[y]?.[x] ? ([x, y] as const) : null,
        ).filter((c): c is readonly [number, number] => c !== null),
      ),
    );
    expect(added).toEqual(shown);
    run.dispose();
  });

  test("a slammed commit replays on the server like any placement", () => {
    const run = newRun();
    run.grabBase();
    run.carryAt({ column: 0, row: 0 });
    run.slamDrop();
    pumpUntil(() => run.snapshot().piecesPlaced === 1);
    const log = structuredClone(run.log());
    const verified = verifyRun(
      { board: decodeBoard(PUZZLE.board, ENGINE_ROWS), queue: PUZZLE.queue, hold: PUZZLE.hold },
      DEFAULT_HANDLING,
      log,
    );
    expect(verified.placements).toHaveLength(1);
    run.dispose();
  });

  test("a flick at the already-seated preview commits the shadow seat", () => {
    const run = newRun();
    run.grabBase();
    run.carryAt({ column: 0, row: 0 }); // zero travel: the preview IS the shadow
    const shown = run.view().aim!.cells;
    expect(run.view().aim?.legal).toBe(true);
    const boardBefore = run.view().cells;
    run.slamDrop();
    expect(run.snapshot().piecesPlaced).toBe(1);
    // What landed is exactly what was shown: the slam added nothing,
    // moved nothing — the seat the finger held is the seat that locked.
    const added = run.view().cells
      .flatMap((row, y) =>
        row.map((cell, x) =>
          cell !== null && boardBefore[y]?.[x] === null ? ([x, y] as const) : null,
        ),
      )
      .filter((c): c is readonly [number, number] => c !== null);
    const seat = (cells: readonly (readonly [number, number])[]) =>
      cells.map(([x, y]) => `${x},${y}`).sort().join(" ");
    expect(seat(added)).toBe(seat(shown));
    run.dispose();
  });

  test("a flick during the rest gate slams the waiting seat, once", () => {
    const run = newRun();
    run.grabBase();
    run.carryAt({ column: 0, row: 0 });
    run.settleAt(); // released: the gate now waits out its rest
    const waiting = run.view().aim;
    expect(waiting?.progress).toBeDefined(); // the gate is open
    expect(run.snapshot().piecesPlaced).toBe(0);
    const seat0 = waiting!.cells;
    // The finger comes back down on the waiting seat: the grab anchors there,
    // and a still finger neither cancels the seat nor moves it.
    run.grabBase();
    expect(run.snapshot().piecesPlaced).toBe(0);
    run.slamDrop(); // ...and the flick hard-drops the seat it was waiting on
    expect(run.snapshot().piecesPlaced).toBe(1);
    // Exactly one commit: the slammed seat stayed slammed — no gate woke
    // up afterwards to place a second piece or to reset the first.
    pump(10);
    expect(run.snapshot().piecesPlaced).toBe(1);
    const added = run.view().cells
      .flatMap((row, y) =>
        row.map((cell, x) =>
          cell !== null && seat0.some(([sx, sy]) => sx === x && sy === y)
            ? ([x, y] as const)
            : null,
        ),
      )
      .filter((c): c is readonly [number, number] => c !== null);
    expect(added.length).toBe(4); // the L's four minos, where the gate pointed
    run.dispose();
  });
});
