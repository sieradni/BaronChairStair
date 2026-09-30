/**
 * Drag to place, driven headlessly.
 *
 * A drag is honest only if it becomes keys — so the whole contract is that a
 * placement made through `aimAt`/`placeAt` leaves a log the server replays to
 * exactly the placement the player saw. These run the real fixed-step loop on
 * the same harness as the undo suite, and check the commit against the same
 * verifier the server uses.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PuzzleRun, cwTurnsBetween } from "../client/src/game/runner";
import { MINO_INK } from "../client/src/render/skin";
import { decodeBoard, ENGINE_ROWS, type PuzzlePrompt } from "../shared/puzzle";
import { DEFAULT_HANDLING } from "../shared/tetris/handling";
import { type InputEvent, parseInputLog, verifyRun } from "../shared/tetris/verify";
import { PATIENCE, pump, pumpUntil, resetHarness, SAFE_LOCK_FRAMES } from "./harness";

const PUZZLE: PuzzlePrompt = {
  id: 1,
  title: "stack",
  author: "test",
  difficulty: 1,
  goal: "place pieces",
  set: null,
  board: [],
  queue: ["O", "O", "O", "O", "O", "O"],
  hold: null,
  // Never met: an O dropped on an empty field clears nothing.
  targetAttack: 4,
};

const SETUP = {
  board: decodeBoard(PUZZLE.board, ENGINE_ROWS),
  queue: PUZZLE.queue,
  hold: PUZZLE.hold,
};

function newRun(): PuzzleRun {
  return new PuzzleRun(PUZZLE, DEFAULT_HANDLING, {
    onFrame: () => {},
    onFinish: () => {},
    onLock: () => {},
  });
}

/** A spot on the floor row, the common case: the finger names the column. */
function floorAim(column: number): { column: number; row: number } {
  return { column, row: 0 };
}

beforeEach(() => {
  resetHarness();
});

describe("drag to place", () => {
  test("an aim at open floor is legal and commits one piece", () => {
    const run = newRun();
    run.aimAt(floorAim(2));
    expect(run.isAiming).toBe(true);

    expect(run.placeAt()).toBe(true);
    expect(run.isAiming).toBe(false);
    pumpUntil(() => run.snapshot().piecesPlaced === 1);
    run.dispose();
  });

  test("the log the drag wrote replays on the server to the same placement", () => {
    const run = newRun();
    run.aimAt(floorAim(2));
    run.placeAt();
    pumpUntil(() => run.snapshot().piecesPlaced === 1);
    pump(SAFE_LOCK_FRAMES);

    const log = structuredClone(run.log()) as InputEvent[];
    // Invariant, same one the undo suite holds the log to: the client and the
    // server may not disagree about what a drag meant.
    expect(parseInputLog(log)).toEqual(log);
    const verified = verifyRun(SETUP, DEFAULT_HANDLING, log);
    expect(verified.placements).toHaveLength(1);
    // The piece is where the finger left it: two columns wide, centred over
    // the aimed column (2), on the floor.
    expect([...verified.placements[0]!.cells].sort((a, b) => a[0] - b[0] || a[1] - b[1])).toEqual([
      [2, 0],
      [2, 1],
      [3, 0],
      [3, 1],
    ]);
    run.dispose();
  });

  test("undo hands the piece back at the seat it was taken from", () => {
    const run = newRun();
    run.aimAt(floorAim(2));
    run.placeAt();
    pumpUntil(() => run.snapshot().piecesPlaced === 1);
    pump(SAFE_LOCK_FRAMES);
    const seat = [
      [2, 0],
      [2, 1],
      [3, 0],
      [3, 1],
    ] as const;

    expect(run.undo()).toBe(true);
    expect(run.snapshot().piecesPlaced).toBe(0);
    // The virtual position survives the take-back: a parked preview at the
    // very squares the placement locked — dashed, held, never committed.
    const parked = run.view().aim;
    expect(parked).not.toBeNull();
    expect(parked?.legal).toBe(false);
    expect(sorted(parked!.cells)).toEqual([...seat]);

    // A grab re-anchors on the parked seat, so the position is live again:
    // zero travel shows the same seat, and the flick re-commits it.
    run.grabBase();
    run.carryAt({ column: 0, row: 0 });
    expect(sorted(run.view().aim!.cells)).toEqual([...seat]);
    run.slamDrop();
    expect(run.snapshot().piecesPlaced).toBe(1);
    pump(SAFE_LOCK_FRAMES);
    // And the server agrees the re-taken seat is the one that locked.
    const log = structuredClone(run.log()) as InputEvent[];
    expect(parseInputLog(log)).toEqual(log);
    const verified = verifyRun(SETUP, DEFAULT_HANDLING, log);
    expect(verified.placements).toHaveLength(1);
    expect([...verified.placements[0]!.cells].sort((a, b) => a[0] - b[0] || a[1] - b[1])).toEqual([
      ...seat,
    ]);
    run.dispose();
  });

  test("each undo level hands back that level's own seat", () => {
    const run = newRun();
    run.aimAt(floorAim(2));
    run.placeAt();
    pumpUntil(() => run.snapshot().piecesPlaced === 1);
    pump(SAFE_LOCK_FRAMES);
    run.aimAt(floorAim(7));
    run.placeAt();
    pumpUntil(() => run.snapshot().piecesPlaced === 2);
    pump(SAFE_LOCK_FRAMES);

    expect(run.undo()).toBe(true);
    expect(run.snapshot().piecesPlaced).toBe(1);
    // The newest take-back parks at the second placement's seat
    // (the O covers the aimed column's left edge: 6-7, as 2-3 above).
    expect(sorted(run.view().aim!.cells)).toEqual([
      [6, 0],
      [6, 1],
      [7, 0],
      [7, 1],
    ]);
    expect(run.undo()).toBe(true);
    expect(run.snapshot().piecesPlaced).toBe(0);
    // One level further down, the first placement's seat comes back instead.
    expect(sorted(run.view().aim!.cells)).toEqual([
      [2, 0],
      [2, 1],
      [3, 0],
      [3, 1],
    ]);
    run.dispose();
  });

  test("redo spends the handed-back piece again and clears the park", () => {
    const run = newRun();
    run.aimAt(floorAim(2));
    run.placeAt();
    pumpUntil(() => run.snapshot().piecesPlaced === 1);
    pump(SAFE_LOCK_FRAMES);
    expect(run.undo()).toBe(true);
    expect(run.view().aim).not.toBeNull(); // the park is showing

    expect(run.redo()).toBe(true);
    pumpUntil(() => run.snapshot().piecesPlaced === 1);
    // The piece is spent again, exactly as the log says: no park survives a
    // redo, and the fresh falling piece speaks with its own shadow.
    expect(run.view().aim).toBeNull();
    expect(run.view().ghost.length).toBeGreaterThan(0);
    run.dispose();
  });

  test("a drag commits a legal key log, not a teleport", () => {
    const run = newRun();
    run.aimAt(floorAim(2));
    run.placeAt();
    pumpUntil(() => run.snapshot().piecesPlaced === 1);
    // Every event is a key the player could have pressed; there is no other
    // kind of event to send.
    for (const event of run.log()) {
      expect(event.type === "keydown" || event.type === "keyup").toBe(true);
    }
    // A hard drop ended it, as letting go of a drag means.
    expect(run.log().some((event) => event.data.key === "hardDrop")).toBe(true);
    run.dispose();
  });

  test("an aim in mid-air is shown but never commits", () => {
    const run = newRun();
    // Row 5 is open air on an empty board: a hard drop from anywhere above
    // falls through it, so nothing can lock exactly there.
    run.aimAt({ column: 2, row: 5 });
    expect(run.isAiming).toBe(true);

    expect(run.placeAt()).toBe(false);
    expect(run.snapshot().piecesPlaced).toBe(0);
    expect(run.log()).toEqual([]);
    pump(PATIENCE);
    expect(run.snapshot().piecesPlaced).toBe(0);
    run.dispose();
  });

  test("a second commit without a fresh aim does nothing", () => {
    const run = newRun();
    run.aimAt(floorAim(2));
    expect(run.placeAt()).toBe(true);
    // The aim was consumed by the first commit; a stale one cannot drop a
    // piece the player has not aimed anywhere.
    expect(run.placeAt()).toBe(false);
    pumpUntil(() => run.snapshot().piecesPlaced === 1);
    pump(SAFE_LOCK_FRAMES);
    expect(run.snapshot().piecesPlaced).toBe(1);
    run.dispose();
  });

  test("a lock takes the aim away", () => {
    const run = newRun();
    run.aimAt(floorAim(6));
    expect(run.isAiming).toBe(true);
    // The player hard drops from the keyboard instead of committing the drag:
    // a real lock, which leaves the aim pointing at a board that no longer
    // exists.
    run.input("hardDrop", true);
    pumpUntil(() => run.snapshot().piecesPlaced === 1);
    run.input("hardDrop", false);
    pump(SAFE_LOCK_FRAMES);
    expect(run.isAiming).toBe(false);
    expect(run.placeAt()).toBe(false);
    run.dispose();
  });

  test("undo clears the aim, and a drag after an undo plays on", () => {
    const run = newRun();
    run.aimAt(floorAim(2));
    run.placeAt();
    pumpUntil(() => run.snapshot().piecesPlaced === 1);
    pump(SAFE_LOCK_FRAMES);

    expect(run.undo()).toBe(true);
    expect(run.isAiming).toBe(false);

    // A fresh drag on the undone board works, and the server agrees.
    run.aimAt(floorAim(7));
    expect(run.placeAt()).toBe(true);
    pumpUntil(() => run.snapshot().piecesPlaced === 1);
    pump(SAFE_LOCK_FRAMES);
    const log = structuredClone(run.log()) as InputEvent[];
    expect(parseInputLog(log)).toEqual(log);
    expect(verifyRun(SETUP, DEFAULT_HANDLING, log).placements).toHaveLength(1);
    run.dispose();
  });

  test("restart clears the aim", () => {
    const run = newRun();
    run.aimAt(floorAim(2));
    expect(run.isAiming).toBe(true);
    run.restart();
    expect(run.isAiming).toBe(false);
    expect(run.placeAt()).toBe(false);
    run.dispose();
  });

  test("two drags in a row place two pieces", () => {
    const run = newRun();
    run.aimAt(floorAim(2));
    run.placeAt();
    pumpUntil(() => run.snapshot().piecesPlaced === 1);
    pump(SAFE_LOCK_FRAMES);
    run.aimAt(floorAim(8));
    run.placeAt();
    pumpUntil(() => run.snapshot().piecesPlaced === 2);
    pump(SAFE_LOCK_FRAMES);

    const log = structuredClone(run.log()) as InputEvent[];
    expect(parseInputLog(log)).toEqual(log);
    expect(verifyRun(SETUP, DEFAULT_HANDLING, log).placements).toHaveLength(2);
    run.dispose();
  });

  test("tapping rotates, and a drag after a tap places the new shape", () => {
    const run = newRun();
    // The O is rotation-symmetric, so rotate a different way: tap hold, and
    // the dragged piece is the one hold produced.
    run.tap("hold");
    pump(1);
    run.aimAt(floorAim(5));
    expect(run.placeAt()).toBe(true);
    pumpUntil(() => run.snapshot().piecesPlaced === 1);
    expect(run.snapshot().piecesPlaced).toBe(1);
    run.dispose();
  });

  test("keyboard input voids a standing aim", () => {
    const run = newRun();
    run.aimAt(floorAim(2));
    expect(run.isAiming).toBe(true);
    // Any key moves the piece, so the target computed for where it stood is
    // a promise about a piece that no longer exists.
    run.input("moveLeft", true);
    run.input("moveLeft", false);
    expect(run.isAiming).toBe(false);
    expect(run.placeAt()).toBe(false);
    run.dispose();
  });

  test("a rotation reaches the next aim without a frame in between", () => {
    // The second-finger rotate queues its key and immediately re-aims; no
    // frame runs in between. The aim must therefore see the piece the
    // rotation produces, not the one that was falling when it was tapped.
    const run = newRun();
    run.tap("rotateCW"); // no pump: the key is still in pending
    run.aimAt(floorAim(2));
    expect(run.placeAt()).toBe(true);
    pumpUntil(() => run.snapshot().piecesPlaced === 1);
    pump(SAFE_LOCK_FRAMES);

    // The spawned T lies flat (two rows tall, three wide); rotated CW it
    // stands up (three rows, two wide). The locked piece says which one the
    // drag was aimed at.
    const log = structuredClone(run.log()) as InputEvent[];
    const verified = verifyRun(SETUP, DEFAULT_HANDLING, log);
    expect(verified.placements).toHaveLength(1);
    const cells = verified.placements[0]!.cells;
    const width = Math.max(...cells.map(([x]) => x)) - Math.min(...cells.map(([x]) => x));
    expect(width).toBe(1); // a standing T, not the spawned flat one
    run.dispose();
  });

  test("a dragged S locks covering the cell the finger named", () => {
    // Cover-the-cell contract, checked end to end: the locked cells must
    // include the pointed square, whatever the piece's shape. An S's centroid
    // sits on a half-cell boundary between its blocks, so centring put the
    // piece one over from the finger — the staircase bug.
    const run = newRun();
    run.aimAt(floorAim(6));
    expect(run.placeAt()).toBe(true);
    pumpUntil(() => run.snapshot().piecesPlaced === 1);
    pump(SAFE_LOCK_FRAMES);
    const log = structuredClone(run.log()) as InputEvent[];
    const verified = verifyRun(SETUP, DEFAULT_HANDLING, log);
    expect(verified.placements[0]!.cells).toContainEqual([6, 0]);
    run.dispose();
  });

  test("a floor aim covers the named cell even for a staggered S", () => {
    // Cover-after-clamp: the nearest pre-clamp shift for a flat S aimed at
    // the floor belongs to an upper block and clamps one row off the finger.
    // The hollow must name the square it will lock, so it must still contain
    // the finger — and the lock must equal the hollow, not the finger's row.
    const sPuzzle: PuzzlePrompt = { ...PUZZLE, queue: ["S", "O", "O", "O", "O", "O"] };
    const run = new PuzzleRun(sPuzzle, DEFAULT_HANDLING, {
      onFrame: () => {},
      onFinish: () => {},
      onLock: () => {},
    });
    run.aimAt(floorAim(6));
    const aim = run.view().aim;
    expect(aim).not.toBeNull();
    expect(aim!.cells).toContainEqual([6, 0]);
    expect(run.placeAt()).toBe(true);
    pumpUntil(() => run.snapshot().piecesPlaced === 1);
    pump(SAFE_LOCK_FRAMES);

    const log = structuredClone(run.log()) as InputEvent[];
    const verified = verifyRun(
      { board: decodeBoard(sPuzzle.board, ENGINE_ROWS), queue: sPuzzle.queue, hold: sPuzzle.hold },
      DEFAULT_HANDLING,
      log,
    );
    expect(verified.placements).toHaveLength(1);
    expect(verified.placements[0]!.cells).toContainEqual([6, 0]);
    expect([...verified.placements[0]!.cells].sort()).toEqual([...aim!.cells].sort());
    run.dispose();
  });

  test("a drag sliding one square keeps a covering hollow steady", () => {
    // Gesture stability: while the finger stays inside the hollow it already
    // saw, the hollow stays put instead of re-centring under the finger; once
    // the finger leaves it, the hollow follows by exactly the finger's move.
    const sPuzzle: PuzzlePrompt = { ...PUZZLE, queue: ["S", "O", "O", "O", "O", "O"] };
    const run = new PuzzleRun(sPuzzle, DEFAULT_HANDLING, {
      onFrame: () => {},
      onFinish: () => {},
      onLock: () => {},
    });
    run.tap("rotateCW");
    run.aimAt(floorAim(4));
    const first = [...run.view().aim!.cells].sort();
    expect(first).toContainEqual([4, 0]);

    run.aimAt({ column: 4, row: 1 });
    const steadied = [...run.view().aim!.cells].sort();
    expect(steadied).toEqual(first);

    run.aimAt({ column: 4, row: 2 });
    const followed = [...run.view().aim!.cells].sort();
    const shifted = first.map(([x, y]) => [x, y + 1] as const).sort();
    expect(followed).toEqual(shifted);
    run.dispose();
  });

  test("a T dropped deep into a slot locks exactly the hollow", () => {
    // Same descent parity for a T in a deep shaft: the route must genuinely
    // drop before its final rotation reaches the seat, and the committed log
    // plays the identical batches, so preview and lock cannot diverge.
    const deep: PuzzlePrompt = {
      ...PUZZLE,
      board: ["XXX.XXXXXX", "XXX...XXXX", "XXX...XXXX"],
      queue: ["T", "O", "O", "O", "O", "O"],
      targetAttack: 1,
    };
    const run = new PuzzleRun(deep, DEFAULT_HANDLING, {
      onFrame: () => {},
      onFinish: () => {},
      onLock: () => {},
    });
    run.tap("rotateCW");
    run.tap("rotateCW");
    pump(2);
    run.aimAt({ column: 4, row: 1 });
    const aim = run.view().aim;
    expect(aim).not.toBeNull();
    expect(aim!.legal).toBe(true);
    expect(run.placeAt()).toBe(true);
    pumpUntil(() => run.snapshot().piecesPlaced === 1);
    pump(SAFE_LOCK_FRAMES);

    const log = structuredClone(run.log()) as InputEvent[];
    const verified = verifyRun(
      { board: decodeBoard(deep.board, ENGINE_ROWS), queue: deep.queue, hold: deep.hold },
      DEFAULT_HANDLING,
      log,
    );
    expect(verified.placements).toHaveLength(1);
    expect([...verified.placements[0]!.cells].sort()).toEqual([...aim!.cells].sort());
    run.dispose();
  });

  test("a flat T dragged at a TSD mouth claims no spin", () => {
    // Ask honesty: the finger names the square *and* the pre-chosen rotation.
    // A flat T over a TSD notch is not a spin ask — it is unreachable — so
    // the hollow is dashed and nothing commits, rather than a double wearing
    // the slot's shape. The spin comes from two taps first (see below).
    const tsd: PuzzlePrompt = {
      ...PUZZLE,
      board: ["XXXX.XXXXX", "XXX...XXXX"],
      queue: ["T", "O", "O", "O", "O", "O"],
      targetAttack: 1,
    };
    const run = new PuzzleRun(tsd, DEFAULT_HANDLING, {
      onFrame: () => {},
      onFinish: () => {},
      onLock: () => {},
    });
    run.aimAt({ column: 4, row: 0 });
    expect(run.view().aim?.legal).toBe(false);
    expect(run.placeAt()).toBe(false);
    expect(run.snapshot().piecesPlaced).toBe(0);
    run.dispose();
  });

  test("a drag whose route drops before its final kick locks exactly the hollow", () => {
    // Trial/commit parity: candidates used to be replayed with `press`,
    // where a mid-route soft drop falls at once, while the commit taps it
    // through `tick`, where a same-frame tap holds nothing and falls nowhere
    // — so a kick after the drop fired from two different heights and the
    // piece locked a kick away from the preview. Trials now tick the taps the
    // log will carry, so a solid hollow is a seat the log lands on.
    const sPuzzle: PuzzlePrompt = { ...PUZZLE, queue: ["S", "O", "O", "O", "O", "O"] };
    const run = new PuzzleRun(sPuzzle, DEFAULT_HANDLING, {
      onFrame: () => {},
      onFinish: () => {},
      onLock: () => {},
    });
    run.tap("rotateCCW");
    run.aimAt(floorAim(0));
    const aim = run.view().aim;
    expect(aim).not.toBeNull();
    expect(aim!.legal).toBe(true);
    expect(run.placeAt()).toBe(true);
    pumpUntil(() => run.snapshot().piecesPlaced === 1);
    pump(SAFE_LOCK_FRAMES);

    const log = structuredClone(run.log()) as InputEvent[];
    const verified = verifyRun(
      { board: decodeBoard(sPuzzle.board, ENGINE_ROWS), queue: sPuzzle.queue, hold: sPuzzle.hold },
      DEFAULT_HANDLING,
      log,
    );
    expect(verified.placements).toHaveLength(1);
    expect([...verified.placements[0]!.cells].sort()).toEqual([...aim!.cells].sort());
    run.dispose();
  });

  test("a seat needing a mid-route descent locks exactly the hollow", () => {
    // Descent parity: the staircase seat beside the teeth needs a real drop
    // before its final kick — a same-frame tap falls nowhere, so the commit
    // holds its soft drop across a tick boundary, and the trial plays the
    // identical batches. The hollow is solid and the log lands on it.
    const stair: PuzzlePrompt = {
      ...PUZZLE,
      board: [
        "....XXXXXX",
        "...XXXXXXX",
        "..XXXXXXXX",
      ],
      queue: ["S", "O", "O", "O", "O", "O"],
      targetAttack: 1,
    };
    const run = new PuzzleRun(stair, DEFAULT_HANDLING, {
      onFrame: () => {},
      onFinish: () => {},
      onLock: () => {},
    });
    run.tap("rotateCW");
    run.aimAt({ column: 1, row: 1 });
    const aim = run.view().aim;
    expect(aim).not.toBeNull();
    expect(aim!.cells).toContainEqual([1, 1]);
    expect(run.placeAt()).toBe(true);
    pumpUntil(() => run.snapshot().piecesPlaced === 1);
    pump(SAFE_LOCK_FRAMES);

    const log = structuredClone(run.log()) as InputEvent[];
    const verified = verifyRun(
      { board: decodeBoard(stair.board, ENGINE_ROWS), queue: stair.queue, hold: stair.hold },
      DEFAULT_HANDLING,
      log,
    );
    expect(verified.placements).toHaveLength(1);
    expect([...verified.placements[0]!.cells].sort()).toEqual([...aim!.cells].sort());
    run.dispose();
  });

  test("pointing at a cell the piece already covers does not move it", () => {
    // The minimal-nudge invariant that discriminates cover-the-cell from
    // centring. The S spawns flat with its centroid on a half-cell boundary
    // (x̄ = 4), so centring a pointed-at block rounds to a spurious one-cell
    // shift; covering picks the zero shift. The O cannot discriminate — its
    // half-cell centroid rounds to no shift either way — hence the S queue.
    const sPuzzle: PuzzlePrompt = { ...PUZZLE, queue: ["S", "O", "O", "O", "O", "O"] };
    const run = new PuzzleRun(sPuzzle, DEFAULT_HANDLING, {
      onFrame: () => {},
      onFinish: () => {},
      onLock: () => {},
    });
    // The piece's own current cells, read from the view the renderer gets:
    // the flat S occupies (3,18), (4,18), (4,19), (5,19).
    const active = [...run.view().active].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    expect(active).toEqual([[3, 18], [4, 18], [4, 19], [5, 19]]);
    // Aim at the leftmost block the piece already sits on.
    run.aimAt({ column: 3, row: 18 });
    const aim = run.view().aim;
    expect(aim).not.toBeNull();
    // The previewed target is the piece exactly where it stands: no shift.
    expect([...aim!.cells].sort((a, b) => a[0] - b[0] || a[1] - b[1])).toEqual(active);
    run.dispose();
  });

  test("a standing S dragged into a staircase nook locks covering the pointed cell", () => {
    // The reported bug: rotate an S vertical, drag it at the staircase, and
    // it locked one up and to the left of the seat. The nook cell the finger
    // names must be part of the piece that locks.
    const stair: PuzzlePrompt = {
      ...PUZZLE,
      // A staircase descending left-to-right, open cells hugging the wall.
      board: [
        "....XXXXXX",
        "...XXXXXXX",
        "..XXXXXXXX",
      ],
      queue: ["S", "O", "O", "O", "O", "O"],
      targetAttack: 1,
    };
    const run = new PuzzleRun(stair, DEFAULT_HANDLING, {
      onFrame: () => {},
      onFinish: () => {},
      onLock: () => {},
    });
    // One tap stands the S up, then the drag points at the nook: the open
    // cell one above the floor against the left wall.
    run.tap("rotateCW");
    run.aimAt({ column: 0, row: 1 });
    expect(run.placeAt()).toBe(true);
    pumpUntil(() => run.snapshot().piecesPlaced === 1);
    pump(SAFE_LOCK_FRAMES);

    const log = structuredClone(run.log()) as InputEvent[];
    const verified = verifyRun(
      { board: decodeBoard(stair.board, ENGINE_ROWS), queue: stair.queue, hold: stair.hold },
      DEFAULT_HANDLING,
      log,
    );
    expect(verified.placements).toHaveLength(1);
    expect(verified.placements[0]!.cells).toContainEqual([0, 1]);
    run.dispose();
  });

  test("a kick placement earns its spin through a drag", () => {
    // A T over a classic TSD notch: a hole two rows deep at column 4 with a
    // solid roof either side. The square is unreachable by sliding — the last
    // input of any honest route into it is a rotation, and the engine has to
    // be the one to say the spin counted.
    const tsd: PuzzlePrompt = {
      ...PUZZLE,
      board: ["XXXX.XXXXX", "XXX...XXXX"],
      queue: ["T", "O", "O", "O", "O", "O"],
      targetAttack: 1,
    };
    const run = new PuzzleRun(tsd, DEFAULT_HANDLING, {
      onFrame: () => {},
      onFinish: () => {},
      onLock: () => {},
    });
    // The spawned T comes to rest flat in the notch's mouth, nub up — the
    // wrong way round. Two taps turn it over (one batch, two rotations), and
    // the drag carries it the rest of the way: the same rotate-then-place
    // flow a thumb plays on a phone.
    run.tap("rotateCW");
    run.tap("rotateCW");
    pump(2); // the taps reach the engine on their frames, like on a real board
    run.aimAt({ column: 4, row: 0 });
    expect(run.placeAt()).toBe(true);
    pumpUntil(() => run.snapshot().piecesPlaced === 1);
    pump(SAFE_LOCK_FRAMES);

    // The attack is the whole point: a TSD sends 11 and it is reachable only
    // if the replayed kick route was credited as a spin.
    const log = structuredClone(run.log()) as InputEvent[];
    const verified = verifyRun(
      { board: decodeBoard(tsd.board, ENGINE_ROWS), queue: tsd.queue, hold: tsd.hold },
      DEFAULT_HANDLING,
      log,
    );
    expect(verified.placements).toHaveLength(1);
    expect(verified.attack).toBe(11);
    // The toy board is two rows, so the TSD that fills its last two holes is
    // also a perfect clear — the engine calls the PC, which is the stronger
    // name for the same credited spin.
    expect(verified.clears).toEqual(["perfect clear"]);
    run.dispose();
  });
});

// ── The carry's endings: place, park, reset ────────────────────────────────

const STACKED: PuzzlePrompt = {
  id: 2,
  title: "stacked",
  author: "test",
  difficulty: 1,
  goal: "place beside a stack",
  set: null,
  // One row of stack on the left; the right half is open floor.
  board: ["GGGG......"],
  queue: ["O", "O", "O", "O", "O", "O"],
  hold: null,
  targetAttack: 4,
};

function newStackedRun(): PuzzleRun {
  return new PuzzleRun(STACKED, DEFAULT_HANDLING, {
    onFrame: () => {},
    onFinish: () => {},
    onLock: () => {},
  });
}

/** The run's on-board preview — the live aim, or the seat a release parked. */
function previewOf(run: PuzzleRun) {
  return run.view().aim;
}

/** The preview's bottom-leftmost corner, for shifts named by corner seat. */
function cornerOf(cells: readonly (readonly [number, number])[]): { column: number; row: number } {
  // Board rows grow upward from the floor at row 0, so the corner that
  // "sits" on a named row is the piece's minimum row — its bottom.
  let column = Infinity;
  let row = Infinity;
  for (const [x, y] of cells) {
    if (x < column) column = x;
    if (y < row) row = y;
  }
  return { column, row };
}

/** The carry shift that moves the current preview's corner to the given seat. */
function shiftTo(run: PuzzleRun, column: number, row: number): { column: number; row: number } {
  const preview = previewOf(run);
  if (!preview) throw new Error("no preview to shift from");
  const from = cornerOf(preview.cells);
  return { column: column - from.column, row: row - from.row };
}

const sorted = (cells: readonly (readonly [number, number])[]) =>
  [...cells].sort((a, b) => a[0] - b[0] || a[1] - b[1]);

describe("the carry's endings", () => {
  test("a grab previews the shadow: the seat the piece would land on", () => {
    const run = newStackedRun();
    run.grabBase();
    // The grab itself shows nothing — the anchor moves nothing.
    expect(previewOf(run)).toBeNull();
    // The first carry of zero names the shadow: where the piece would rest
    // if it dropped now. On the open half of the board that is the floor —
    // legal, rows 0–1 — though the piece hangs far above it.
    run.carryAt({ column: 0, row: 0 });
    const shadow = sorted(previewOf(run)!.cells);
    expect(previewOf(run)?.legal).toBe(true);
    expect(Math.min(...shadow.map(([, y]) => y))).toBe(0);
    // Carried one square up, the preview sits on the stack's row: the
    // anchor is the landing seat, not the hanging piece.
    run.carryAt({ column: 0, row: 1 });
    expect(previewOf(run)?.legal).toBe(false);
    expect(run.snapshot().piecesPlaced).toBe(0);
    expect(run.log()).toEqual([]);
    run.dispose();
  });

  test("a release waits out its rest, then commits exactly what was previewed", () => {
    const run = newStackedRun();
    run.grabBase();
    // The first carry of zero names the shadow.
    run.carryAt({ column: 0, row: 0 });
    run.carryAt(shiftTo(run, 8, 0)); // to open floor right of the stack
    const shown = sorted(previewOf(run)!.cells);
    expect(previewOf(run)?.legal).toBe(true);
    run.settleAt();
    // The release does not spend the piece: the gate holds the preview.
    expect(run.snapshot().piecesPlaced).toBe(0);
    expect(sorted(previewOf(run)!.cells)).toEqual(shown);
    pumpUntil(() => run.snapshot().piecesPlaced === 1);

    // What locked is what was shown, shifted to the seat the finger named.
    const committed = run.view().cells;
    for (const [x, y] of shown) {
      const dx = 8 - cornerOf(shown).column;
      const dy = 0 - cornerOf(shown).row;
      expect(committed[y + dy]![x + dx]).not.toBeNull();
    }
    run.dispose();
  });

  test("a re-grab that moves away cancels the gate: nothing commits", () => {
    const run = newStackedRun();
    run.grabBase();
    run.carryAt({ column: 0, row: 0 });
    run.carryAt(shiftTo(run, 8, 0));
    run.settleAt();
    expect(previewOf(run)).not.toBeNull();
    // The finger comes back down on the arranged seat — the grab anchors
    // there and the wait survives the touch — and then the player drags
    // away: the seat the gate was holding is no longer the seat showing,
    // so the wait dies with the move.
    run.grabBase();
    run.carryAt({ column: 0, row: 0 });
    expect(previewOf(run)).not.toBeNull();
    run.carryAt(shiftTo(run, 3, 1)); // a real move: a change of mind
    pump(50); // well past the rest (≈833ms, clear of the 750ms gate)
    expect(run.snapshot().piecesPlaced).toBe(0);
    expect(run.log()).toEqual([]);
    // And the piece is still the player's: carried to a seat (the shift is
    // measured from the drag's anchor, corner 8 — so -1 puts corner 7, and
    // the S's foot reaches column 9) and flicked, it places as ever.
    run.carryAt({ column: -1, row: 0 });
    expect(previewOf(run)?.legal).toBe(true);
    run.slamDrop();
    expect(run.snapshot().piecesPlaced).toBe(1);
    run.dispose();
  });

  test("a hand on the piece holds the wait: the gate cannot commit under it", () => {
    const run = newStackedRun();
    run.grabBase();
    run.carryAt({ column: 0, row: 0 });
    run.carryAt(shiftTo(run, 8, 0));
    run.settleAt(); // gate open on the arranged seat
    const waiting = sorted(run.view().aim!.cells);
    // The finger comes back down and holds still. The drag continues from the
    // position the player arranged — not yanked to the piece's own shadow —
    // and the wait keeps its seat but stops counting. This is the commit that
    // used to run on under a still grab: the piece locked while the player was
    // holding it, and the gesture that followed landed on the piece after it.
    run.contactDown();
    run.grabBase();
    run.carryAt({ column: 0, row: 0 });
    expect(run.view().aim?.progress).toBe(0); // held, not counting
    pump(50); // ≈833ms, well past the 750ms gate
    expect(run.snapshot().piecesPlaced).toBe(0);
    expect(sorted(run.view().aim!.cells)).toEqual(waiting); // the seat survived
    // The lift starts the rest over: the commit is still the arranged seat,
    // and it is still the player's to make.
    run.contactUp();
    pumpUntil(() => run.snapshot().piecesPlaced === 1);
    run.dispose();
  });

  test("an arrangement speaks for the piece: the natural shadow stays away", () => {
    // Two previews in the piece's own ink, one of them the untouched landing
    // spot and the other the seat being steered, is a board telling the player
    // two different things. While an arrangement is up it is the one that
    // speaks — the live aim, the parked seat, the gate's wait — and the
    // engine's own shadow comes back with the arrangement's end.
    const run = newStackedRun();
    expect(run.view().ghost.length).toBeGreaterThan(0);
    run.grabBase();
    run.carryAt({ column: 0, row: 0 });
    expect(run.view().aim).not.toBeNull();
    expect(run.view().ghost).toEqual([]);
    run.carryAt(shiftTo(run, 8, 0)); // onto the open floor: legal
    run.settleAt(); // and the gate takes the screen
    expect(run.view().aim?.progress).toBeDefined();
    expect(run.view().ghost).toEqual([]);
    run.cancelCarry();
    expect(run.view().aim).toBeNull();
    expect(run.view().ghost.length).toBeGreaterThan(0); // the shadow speaks again
    run.dispose();
  });

  test("a grab during the rest carries the arranged seat as the anchor", () => {
    const run = newStackedRun();
    run.grabBase();
    run.carryAt({ column: 0, row: 0 });
    run.carryAt(shiftTo(run, 8, 0));
    run.settleAt();
    const arranged = sorted(run.view().aim!.cells);
    run.grabBase(); // anchored on the gate's seat, wherever the piece hangs
    run.carryAt({ column: -4, row: 0 }); // travel left: continues from the seat
    const carried = sorted(run.view().aim!.cells);
    expect(carried).toEqual(arranged.map(([x, y]) => [x - 4, y]));
    // Returning the finger home is the arranged seat again — the shift is
    // measured from where the drag anchored.
    run.carryAt({ column: 0, row: 0 });
    expect(sorted(run.view().aim!.cells)).toEqual(arranged);
    run.slamDrop();
    expect(run.snapshot().piecesPlaced).toBe(1);
    run.dispose();
  });

  test("a swipe drops the seat the preview is showing, not the drag's anchor", () => {
    const run = newStackedRun();
    run.grabBase();
    run.carryAt({ column: 0, row: 0 });
    run.carryAt(shiftTo(run, 8, 0)); // the preview carried to the far column
    const shown = sorted(previewOf(run)!.cells);
    expect(previewOf(run)?.legal).toBe(true);
    const before = run.view().cells;
    run.slamDrop();
    // No wait, no release: the piece is spent at once — at the seat on
    // screen, the one the finger carried the preview to. The drag's anchor
    // is where the piece stood when the stroke began, and a tuck is reached
    // by dragging the piece exactly that far down: dropping the anchor
    // instead would undo the move the player just made.
    expect(run.snapshot().piecesPlaced).toBe(1);
    const committed = sorted(
      run.view().cells.flatMap((row, y) =>
        row.map((cell, x) =>
          cell && !before[y]?.[x] ? ([x, y] as const) : null,
        ).filter((c): c is readonly [number, number] => c !== null),
      ),
    );
    expect(committed).toEqual(shown);
    run.dispose();
  });

  test("rotating mid-air then grabbing re-anchors on the shown preview", () => {
    // The user's report: after a rotation (which ends the drag), grabbing
    // again and dragging teleported the preview back to the piece's
    // physical shadow after one square of travel. The grab anchors on the
    // shown position — here the dangling aim the rotation left — so the
    // piece moves FROM where the player sees it, never to the shadow.
    const run = newStackedRun();
    run.grabBase();
    run.carryAt({ column: 0, row: 0 });
    run.carryAt(shiftTo(run, 4, 1)); // the piece is arranged mid-air, floating
    run.tap("rotateCW"); // ends the drag; the preview dangles, rotated in place
    const shown = sorted(previewOf(run)!.cells);
    run.grabBase(); // the finger comes back down
    run.carryAt({ column: 0, row: 0 }); // zero travel: exactly what was shown
    expect(sorted(previewOf(run)!.cells)).toEqual(shown); // not the physical shadow
    // The first square of travel moves the piece one square from where it
    // was shown — the jump is gone. The shift is measured from the SHOWN
    // corner, so a one-corner-square move is one amplified square.
    const from = cornerOf(shown);
    run.carryAt({ column: 0, row: -1 });
    expect(cornerOf(previewOf(run)!.cells).row).toBe(from.row - 1);
    run.dispose();
  });

  test("a drag-grab after a key move restarts from the piece's own position", () => {
    // The key-move case, stated honestly: moveLeft clears the aim (the
    // piece moved under it — there is no position left to preserve), so
    // the next grab anchors on the piece's own shadow, exactly like a
    // fresh grab. The position on screen is gone; the piece is what is
    // grabbed.
    const run = newStackedRun();
    run.grabBase();
    run.carryAt({ column: 0, row: 0 });
    run.carryAt(shiftTo(run, 4, 1));
    run.tap("moveLeft"); // the piece shifts left; the dangling aim is gone
    expect(previewOf(run)).toBeNull();
    run.grabBase();
    run.carryAt({ column: 0, row: 0 });
    // The fresh grab's shadow sits at the PIECE's column — one left of the
    // arrangement, where the key moved it — not at the arranged position.
    expect(cornerOf(previewOf(run)!.cells).column).toBe(3);
    run.dispose();
  });

  test("a rotation mid-carry re-derives the preview instead of resetting it", () => {
    const run = newStackedRun();
    run.grabBase();
    run.carryAt({ column: 0, row: 0 });
    run.carryAt(shiftTo(run, 8, 0));
    const shown = sorted(previewOf(run)!.cells);
    expect(previewOf(run)?.legal).toBe(true);
    // The tap used to end the drag — the preview would be gone here.
    run.tap("rotateCW");
    expect(previewOf(run)).not.toBeNull();
    // The preview re-derived from the rotated piece at the same travel.
    expect(sorted(previewOf(run)!.cells)).toEqual(shown);
    // And it still places, straight from the carried state.
    run.settleAt();
    pumpUntil(() => run.snapshot().piecesPlaced === 1);
    run.dispose();
  });

  test("a rotation re-derives from a parked anchor too, seat-bottom steady", () => {
    const run = newStackedRun();
    run.grabBase();
    run.carryAt({ column: 0, row: 0 });
    run.carryAt(shiftTo(run, 0, 0)); // park on the stack
    run.settleAt();
    run.grabBase(); // anchored on the park
    const parked = sorted(previewOf(run)!.cells);
    run.carryAt({ column: 0, row: 0 });
    expect(sorted(previewOf(run)!.cells)).toEqual(parked);
    run.carryAt(shiftTo(run, 8, 0));
    expect(previewOf(run)?.legal).toBe(true);
    run.tap("rotateCW");
    expect(previewOf(run)).not.toBeNull();
    // The preview's bottom row survived the rotation in place.
    expect(Math.min(...previewOf(run)!.cells.map(([, y]) => y))).toBe(0);
    // The drop takes the seat the preview is showing — the rotated piece
    // where it was carried — never the parked seat the drag anchored on.
    const shown = sorted(previewOf(run)!.cells);
    const before = run.view().cells;
    run.slamDrop();
    expect(run.snapshot().piecesPlaced).toBe(1);
    const committed = sorted(
      run.view().cells.flatMap((row, y) =>
        row.map((cell, x) =>
          cell && !before[y]?.[x] ? ([x, y] as const) : null,
        ).filter((c): c is readonly [number, number] => c !== null),
      ),
    );
    expect(committed).toEqual(shown);
    run.dispose();
  });

  test("rotating during the lock cancels it, but rotates the seat in place", () => {
    // The user's report, twice over: the rotation must cancel the lock —
    // a key is a key, and the piece stays unspent — but the seat the
    // player arranged must not TELEPORT back to the piece's physical
    // shadow while it happens. The preview re-derives onto the rotated
    // piece at the same corner; the commit it was waiting for is gone.
    const run = newStackedRun();
    run.grabBase();
    run.carryAt({ column: 0, row: 0 });
    run.carryAt(shiftTo(run, 8, 0));
    run.settleAt();
    const waitingRow = Math.min(...run.view().aim!.cells.map(([, y]) => y));
    run.tap("rotateCW"); // cancels the gate; the seat rotates in place
    const rotated = previewOf(run);
    expect(rotated).not.toBeNull(); // the position survived, not reset
    expect(Math.min(...rotated!.cells.map(([, y]) => y))).toBe(waitingRow); // same bottom row
    expect(rotated!.legal).toBe(true); // re-derived onto the rotated piece
    pump(50); // well past the rest: the cancelled gate must not commit
    expect(run.snapshot().piecesPlaced).toBe(0);
    expect(run.log().length).toBeGreaterThan(0); // the rotation played
    // And the player can still finish the arrangement from here: re-seat
    // and the gate opens again on the rotated piece.
    run.carryAt({ column: 0, row: 0 });
    run.settleAt();
    pumpUntil(() => run.snapshot().piecesPlaced === 1);
    run.dispose();
  });

  test("a non-rotating key during the rest still cancels the gate", () => {
    const run = newStackedRun();
    run.grabBase();
    run.carryAt({ column: 0, row: 0 });
    run.carryAt(shiftTo(run, 8, 0));
    run.settleAt();
    run.tap("moveLeft"); // a move is a change of mind: the gate dies
    // The seat went with the gate: had the wait survived the key, the ring
    // would still be promising a commit the player has just walked away
    // from — `piecesPlaced` alone cannot see that, because the cleared aim
    // is what leaves `placeAt` nothing to commit.
    expect(run.view().aim).toBeNull();
    pump(50); // ≈833ms, clear of the 750ms gate: had it lived, it would have committed.
    expect(run.snapshot().piecesPlaced).toBe(0);
    expect(run.log().length).toBeGreaterThan(0); // the key played, though
    run.dispose();
  });

  test("the view carries the gate's progress while the piece waits", () => {
    const run = newStackedRun();
    run.grabBase();
    run.carryAt({ column: 0, row: 0 });
    run.carryAt(shiftTo(run, 8, 0));
    run.settleAt();
    // A slice of the rest: part-way through, not done.
    pump(10);
    const waiting = run.view().aim;
    expect(waiting?.progress).toBeGreaterThan(0);
    expect(waiting?.progress).toBeLessThan(1);
    pumpUntil(() => run.snapshot().piecesPlaced === 1);
    // The ring rides the commit briefly, then fades away with the gate.
    expect(run.view().aim?.progress).toBeGreaterThanOrEqual(1);
    pump(60);
    expect(run.view().aim?.progress).toBeUndefined();
    run.dispose();
  });

  test("a release on an obstructed seat parks the piece exactly as previewed", () => {
    const run = newStackedRun();
    run.grabBase();
    run.carryAt({ column: 0, row: 0 });
    run.carryAt(shiftTo(run, 0, 0)); // corner onto the stack: shown, not placeable
    const preview = previewOf(run)!;
    expect(preview.legal).toBe(false);
    const shown = sorted(preview.cells);
    run.settleAt();
    // The park is the preview, kept — the dashed ghost stays on the stack.
    const parked = previewOf(run)!;
    expect(parked.legal).toBe(false);
    expect(sorted(parked.cells)).toEqual(shown);
    expect(run.snapshot().piecesPlaced).toBe(0);
    expect(run.log()).toEqual([]); // nothing was spent parking
    run.dispose();
  });

  test("a release off the board resets, and the piece can still be placed after", () => {
    const run = newStackedRun();
    run.grabBase();
    run.carryAt({ column: 0, row: 0 });
    run.carryAt(shiftTo(run, 8, 0)); // a legal seat first...
    expect(previewOf(run)).not.toBeNull();
    run.carryAt({ column: -9, row: 0 }); // ...then carried past the left edge
    // Off the board the preview drops — that is the reset — but the drag
    // stays live, and the finger can come back before releasing.
    expect(previewOf(run)).toBeNull();
    run.settleAt(); // the finger let go while off-board
    expect(previewOf(run)).toBeNull();
    expect(run.snapshot().piecesPlaced).toBe(0);
    expect(run.log()).toEqual([]);

    // The piece is alive: a fresh drag places it as if nothing happened.
    // (The zero carry shows the piece floating where it is — dashed, as
    // always for a seat no route can reach — and the floor shift commits.)
    run.grabBase();
    run.carryAt({ column: 0, row: 0 });
    expect(previewOf(run)).not.toBeNull();
    run.carryAt(shiftTo(run, 8, 0));
    expect(previewOf(run)?.legal).toBe(true);
    run.settleAt();
    pumpUntil(() => run.snapshot().piecesPlaced === 1);
    run.dispose();
  });

  test("a re-drag after parking starts from the parked seat", () => {
    const run = newStackedRun();
    run.grabBase();
    run.carryAt({ column: 0, row: 0 });
    run.carryAt(shiftTo(run, 0, 0)); // park on the stack
    run.settleAt();
    const parked = sorted(previewOf(run)!.cells);

    // The next drag anchors at the park: a zero carry shows the same seat.
    run.grabBase();
    run.carryAt({ column: 0, row: 0 });
    expect(sorted(previewOf(run)!.cells)).toEqual(parked);
    // Carried off the stack to open floor, it commits from there.
    run.carryAt(shiftTo(run, 8, 0));
    expect(previewOf(run)?.legal).toBe(true);
    run.settleAt();
    pumpUntil(() => run.snapshot().piecesPlaced === 1);
    run.dispose();
  });

  test("releasing off-board from a park resets the park, and the piece falls on", () => {
    const run = newStackedRun();
    run.grabBase();
    run.carryAt({ column: 0, row: 0 });
    run.carryAt(shiftTo(run, 0, 0)); // park on the stack
    run.settleAt();
    expect(previewOf(run)).not.toBeNull(); // the dashed ghost stands

    // The finger comes back, drags the parked ghost past the top edge and
    // lets go there: the park must go with it — the reset is the same reset
    // a falling piece gets, not a park that survives its own drag.
    run.grabBase();
    run.carryAt({ column: 0, row: 0 });
    run.carryAt({ column: 0, row: 60 }); // every cell above the ceiling
    expect(previewOf(run)).toBeNull(); // preview dropped, drag still live
    run.settleAt();
    expect(previewOf(run)).toBeNull(); // the park did not survive
    expect(run.snapshot().piecesPlaced).toBe(0);
    expect(run.log()).toEqual([]); // and nothing was spent by any of it

    // The piece is untouched and placeable, as after any reset.
    run.grabBase();
    run.carryAt({ column: 0, row: 0 });
    run.carryAt(shiftTo(run, 8, 0));
    expect(previewOf(run)?.legal).toBe(true);
    run.settleAt();
    pumpUntil(() => run.snapshot().piecesPlaced === 1);
    run.dispose();
  });

  test("after an undo the physical piece is spun to the park's orientation", () => {
    // The reported contract: take back a placement made with a rotated
    // piece and BOTH the virtual park and the physical piece show that
    // rotation — the piece is re-spawned flat by the rebuild, so undo
    // spins it to the seat's orientation with silent rotateCW pairs. A
    // flat piece under a 180ed (or vertical) park is exactly the desync
    // that made every later rotation tap look insane.
    // The O cannot discriminate orientations; an S stands with one tap.
    const sPuzzle: PuzzlePrompt = { ...PUZZLE, queue: ["S", "O", "O", "O", "O", "O"] };
    const sRun = new PuzzleRun(sPuzzle, DEFAULT_HANDLING, {
      onFrame: () => {},
      onFinish: () => {},
      onLock: () => {},
    });
    sRun.tap("rotateCW");
    sRun.aimAt(floorAim(2));
    expect(sRun.placeAt()).toBe(true);
    pumpUntil(() => sRun.snapshot().piecesPlaced === 1);
    pump(SAFE_LOCK_FRAMES);
    expect(sRun.undo()).toBe(true);

    // The park holds the locked seat — a standing S, three rows tall —
    // and the physical piece now agrees with it — zero turns between
    // them, where the rebuild alone had left the piece flat.
    const parked = sRun.view().aim;
    expect(parked).not.toBeNull();
    const parkedCells = sorted(parked!.cells);
    const height =
      Math.max(...parkedCells.map(([, y]) => y)) - Math.min(...parkedCells.map(([, y]) => y)) + 1;
    expect(height).toBe(3); // the seat was locked vertical, and the park kept it
    expect(cwTurnsBetween(sRun.view().active, parked!.cells)).toBe(0);

    // Playing on from the take-back, the sync rides in the log as ordinary
    // keys: place the handed-back piece again and the server replays the
    // whole log — sync pairs included — to exactly the placement the park
    // showed.
    sRun.grabBase();
    sRun.carryAt({ column: 0, row: 0 });
    sRun.slamDrop();
    expect(sRun.snapshot().piecesPlaced).toBe(1);
    pump(SAFE_LOCK_FRAMES);
    const syncLog = structuredClone(sRun.log()) as InputEvent[];
    expect(syncLog.some((e) => e.data.key === "rotateCW")).toBe(true); // the sync is IN the log
    expect(parseInputLog(syncLog)).toEqual(syncLog);
    const syncVerified = verifyRun(
      {
        board: decodeBoard(sPuzzle.board, ENGINE_ROWS),
        queue: sPuzzle.queue,
        hold: sPuzzle.hold,
      },
      DEFAULT_HANDLING,
      syncLog,
    );
    expect(syncVerified.placements).toHaveLength(1);
    expect(sorted(syncVerified.placements[0]!.cells)).toEqual(parkedCells);
    sRun.dispose();
  });

  test("undoing a placement made after a hold keeps the hold swap", () => {
    // The reported flow, exactly: hold Z, place J (drag or keys), undo.
    // The hold pair sits in the log BEFORE the placement's boundary, so the
    // first undo used to cut it too — the held Z re-spawning (bay Z,
    // physical Z) while the parked preview still described the J's seat: a
    // red J ghost over a physical Z. A completed swap now opens its own
    // boundary, so the first undo keeps the swap and parks the J seat.
    const zj: PuzzlePrompt = { ...PUZZLE, queue: ["Z", "J", "O", "O", "O", "O"] };
    const run = new PuzzleRun(zj, DEFAULT_HANDLING, {
      onFrame: () => {},
      onFinish: () => {},
      onLock: () => {},
    });
    run.tap("hold"); // Z into the bay, J spawns
    pump(2);
    expect(run.snapshot().hold).toBe("Z");
    run.aimAt(floorAim(2));
    expect(run.placeAt()).toBe(true);
    pumpUntil(() => run.snapshot().piecesPlaced === 1);
    pump(SAFE_LOCK_FRAMES);
    expect(run.undo()).toBe(true);
    // The placement is taken back; the HOLD STAYS: the bay still reads Z
    // (the swap was kept), and the falling piece is the J — the same piece
    // the park describes, not a re-spawned Z. The letter is the point of
    // this test: the reported bug was a red J ghost over a physical Z.
    expect(run.snapshot().hold).toBe("Z");
    // The falling piece is the J (the reported bug: a red J ghost over a
    // physical Z). Ink by letter, so the discrimination is exact.
    expect(run.view().activeInk).toBe(MINO_INK.J);
    const parked = run.view().aim;
    expect(parked).not.toBeNull();
    expect(parked!.legal).toBe(false); // the locked seat, dashed as ever
    expect(cwTurnsBetween(run.view().active, parked!.cells)).toBe(0); // physical IS the J
    // And a second undo reverts the swap itself: the bay empties and the Z
    // is falling again.
    expect(run.undo()).toBe(true);
    expect(run.snapshot().hold).toBeNull();
    run.dispose();
  });

  test("redo survives the undo-time sync: the redone log is the one the player played", () => {
    // The sync pairs are housekeeping — recorded on the segment and
    // stripped again by redo, so the redone log is byte-for-byte the log
    // the player played, and the placement spends again exactly as before.
    const sPuzzle: PuzzlePrompt = { ...PUZZLE, queue: ["S", "O", "O", "O", "O", "O"] };
    const sRun = new PuzzleRun(sPuzzle, DEFAULT_HANDLING, {
      onFrame: () => {},
      onFinish: () => {},
      onLock: () => {},
    });
    sRun.tap("rotateCW");
    sRun.aimAt(floorAim(2));
    expect(sRun.placeAt()).toBe(true);
    pumpUntil(() => sRun.snapshot().piecesPlaced === 1);
    pump(SAFE_LOCK_FRAMES);
    // The seat is derived from the placement's own verified log, never
    // hand-built: redo must reproduce the very placement that was taken
    // back, whatever squares it covered.
    const firstLog = structuredClone(sRun.log()) as InputEvent[];
    const firstVerified = verifyRun(
      {
        board: decodeBoard(sPuzzle.board, ENGINE_ROWS),
        queue: sPuzzle.queue,
        hold: sPuzzle.hold,
      },
      DEFAULT_HANDLING,
      firstLog,
    );
    expect(firstVerified.placements).toHaveLength(1);
    const seat = sorted(firstVerified.placements[0]!.cells);
    expect(sRun.undo()).toBe(true);
    expect(sRun.view().aim).not.toBeNull(); // the park is showing

    expect(sRun.redo()).toBe(true);
    pumpUntil(() => sRun.snapshot().piecesPlaced === 1);
    pump(SAFE_LOCK_FRAMES);
    // No park survives a redo, and the fresh falling piece speaks with its
    // own shadow.
    expect(sRun.view().aim).toBeNull();
    expect(sRun.view().ghost.length).toBeGreaterThan(0);
    const log = structuredClone(sRun.log()) as InputEvent[];
    expect(parseInputLog(log)).toEqual(log);
    const verified = verifyRun(
      {
        board: decodeBoard(sPuzzle.board, ENGINE_ROWS),
        queue: sPuzzle.queue,
        hold: sPuzzle.hold,
      },
      DEFAULT_HANDLING,
      log,
    );
    expect(verified.placements).toHaveLength(1);
    expect(sorted(verified.placements[0]!.cells)).toEqual(seat);
    sRun.dispose();
  });

  test("rotating a parked piece rotates park and piece together, in place", () => {
    // The teleport, pinned at the source: after the undo parks a rotated
    // piece (synced to it), each rotation tap must advance BOTH one
    // quarter-turn from the seat's current orientation — the park redrawn
    // from the piece's post-tap cells at the same corner, the piece under
    // it matching — never snapping the seat back to a stale orientation.
    // The piece is a T: four distinct orientations make the test
    // direction-sensitive — an S (or I, O, Z) has only two, and a
    // counterclockwise geometry helper passes every one of its checks.
    const tPuzzle: PuzzlePrompt = { ...PUZZLE, queue: ["T", "O", "O", "O", "O", "O"] };
    const run = new PuzzleRun(tPuzzle, DEFAULT_HANDLING, {
      onFrame: () => {},
      onFinish: () => {},
      onLock: () => {},
    });
    run.tap("rotateCW"); // stand the T up
    run.aimAt(floorAim(2));
    expect(run.placeAt()).toBe(true);
    pumpUntil(() => run.snapshot().piecesPlaced === 1);
    pump(SAFE_LOCK_FRAMES);
    expect(run.undo()).toBe(true);
    const firstPark = sorted(run.view().aim!.cells);

    run.tap("rotateCW");
    const secondPark = sorted(run.view().aim!.cells);
    expect(run.view().aim).not.toBeNull();
    expect(cwTurnsBetween(firstPark, secondPark)).toBe(1); // one CW turn — a CCW helper reads 3 here
    expect(cornerOf(firstPark)).toEqual(cornerOf(secondPark)); // in place
    expect(cwTurnsBetween(run.view().active, secondPark)).toBe(0); // piece matches the park

    run.tap("rotateCW");
    const thirdPark = sorted(run.view().aim!.cells);
    expect(run.view().aim).not.toBeNull();
    expect(cwTurnsBetween(secondPark, thirdPark)).toBe(1); // the next tap rotates BOTH normally
    expect(cornerOf(secondPark)).toEqual(cornerOf(thirdPark));
    expect(cwTurnsBetween(run.view().active, thirdPark)).toBe(0);
    run.dispose();
  });
});
