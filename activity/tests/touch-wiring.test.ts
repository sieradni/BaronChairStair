/**
 * The gestures a player makes, wired the way the app wires them.
 *
 * The unit suites pin the tracker's verdicts and the run's own rules
 * separately; these drive a real {@link PointerGestureTracker} into a real
 * `PuzzleRun` through the same adapter the play surface uses — contact counts,
 * carry, settle, slam, rotate — so the seam is what is tested. Each test below
 * is one of the placements the review found being committed that the player
 * never chose, or a seat a finger or a key could take away from them.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import {
  HOLD_MS,
  PointerGestureTracker,
  TOUCH_CARRY,
  type Gesture,
  type PointerBoard,
} from "../client/src/game/pointer";
import { PuzzleRun } from "../client/src/game/runner";
import { DEFAULT_HANDLING } from "../shared/tetris/handling";
import { decodeBoard, ENGINE_ROWS, type PuzzlePrompt } from "../shared/puzzle";
import { pump, pumpUntil, resetHarness } from "./harness";

/** The board the review's tuck reproduction is built on, bottom rows first. */
const TUCK: PuzzlePrompt = {
  id: 901,
  title: "tuck",
  author: "test",
  difficulty: 1,
  goal: "place pieces",
  set: null,
  board: ["G.........", "G.........", ".....GGGGG"],
  queue: ["O", "O", "O", "O", "O", "O"],
  hold: null,
  targetAttack: 4,
};

/** An open field, where the only obstruction is the piece's own shadow. */
const OPEN: PuzzlePrompt = {
  id: 902,
  title: "open",
  author: "test",
  difficulty: 1,
  goal: "place pieces",
  set: null,
  board: [],
  queue: ["Z", "J", "O", "O", "O", "O"],
  hold: null,
  targetAttack: 4,
};

/**
 * A tracker over a run, wired as `attachPointerPlay` wires it.
 *
 * Samples are plain finger squares — the tracker's own convention: columns to
 * the right, rows counting up from the floor, so a finger moving DOWN is a
 * decreasing row. The hold clock is hand-fired, because a real timer is the one
 * thing a headless suite cannot wait out.
 */
function wired(puzzle: PuzzlePrompt) {
  const run = new PuzzleRun(puzzle, DEFAULT_HANDLING, {
    onFrame: () => {},
    onFinish: () => {},
    onLock: () => {},
  });
  const board: PointerBoard = {
    sampleAt: (x, y) => ({ column: x, row: y }),
    contactDown: () => run.contactDown(),
    contactUp: () => run.contactUp(),
    grabBase: () => run.grabBase(),
    carryAt: (shift) => run.carryAt(shift),
    settleAt: () => run.settleAt(),
    slamDrop: (origin) => run.slamDrop(origin),
    cancelCarry: () => run.cancelCarry(),
    rotate: () => run.tap("rotateCW"),
    hold: () => run.tap("hold"),
    undo: () => run.undo(),
    redo: () => run.redo(),
  };
  const play = (gesture: Gesture | null): void => {
    if (!gesture) return;
    switch (gesture.type) {
      case "grab":
        board.grabBase();
        break;
      case "carry":
        board.carryAt(gesture.shift);
        break;
      case "settle":
        board.settleAt();
        break;
      case "slam":
        board.slamDrop(gesture.origin);
        break;
      case "cancel":
        board.cancelCarry();
        break;
      case "rotate":
        board.rotate();
        break;
      case "hold":
        board.hold();
        break;
    }
  };
  const timers = new Map<number, () => void>();
  let armed = 0;
  const tracker = new PointerGestureTracker(play, HOLD_MS, {
    schedule: (fn) => {
      timers.set(++armed, fn);
      return armed;
    },
    cancel: (token) => {
      timers.delete(token as number);
    },
  });
  /** The contact lands: the adapter counts it, then the tracker hears it. */
  const down = (column: number, row: number, now: number): void => {
    board.contactDown();
    play(tracker.press({ column, row }, now, TOUCH_CARRY));
  };
  const move = (column: number, row: number, now: number): void => {
    play(tracker.move({ column, row }, now));
  };
  const up = (now: number): void => {
    const verdict = tracker.release(now);
    board.contactUp();
    play(verdict);
  };
  /** The hold window elapsing under a still finger: the long press fires. */
  const fireHold = (): void => {
    const fn = [...timers.values()][0];
    timers.clear();
    fn?.();
  };
  return { run, tracker, play, down, move, up, fireHold };
}

/** Every board cell the run has added since `before`, as sorted squares. */
function added(run: PuzzleRun, before: readonly (readonly (null | string)[])[]): string[] {
  return run
    .view()
    .cells.flatMap((row, y) =>
      row.map((cell, x) => (cell !== null && before[y]?.[x] === null ? `${x},${y}` : null)),
    )
    .filter((cell): cell is string => cell !== null)
    .sort();
}

const seat = (cells: readonly (readonly [number, number])[]): string[] =>
  cells.map(([x, y]) => `${x},${y}`).sort();

beforeEach(() => {
  resetHarness();
});

describe("the gestures, wired to the run", () => {
  test("a slow drag into a tuck locks the tuck, not the seat it started on", () => {
    // The review's reproduction, exactly: drag straight down two and a bit
    // finger squares in under half a second — an unhurried drag on a phone —
    // then rest the finger on the seat the preview is showing. The stroke arms
    // on the way (three amplified squares), and it used to stay armed through
    // any stall, so the lift hard-dropped the seat the drag BEGAN on: the piece
    // landed on top of the overhang instead of in the tuck beneath it.
    const { run, down, move, up } = wired(TUCK);
    const before = run.view().cells;
    down(4, 10, 0);
    move(4, 7.9, 40); // 2.1 finger squares down: three amplified, the tuck's row
    const shown = seat(run.view().aim!.cells);
    expect(run.view().aim?.legal).toBe(true);
    expect(shown).toEqual(["4,0", "4,1", "5,0", "5,1"]); // the tuck, under the overhang
    up(1400); // the finger rests on it, then lifts: the stall ended the stroke
    expect(run.view().aim?.progress).toBeDefined(); // so the seat settles, ring and all
    pumpUntil(() => run.snapshot().piecesPlaced === 1);
    expect(added(run, before)).toEqual(shown);
    run.dispose();
  });

  test("a fast flick hard-drops the seat the stroke began on, with no wait", () => {
    // The same drag, flicked the moment the dive ends: the slam is ONE command
    // whose target is the seat the piece was shown at when the stroke began —
    // here the spawn seat, shifted nowhere. The command hard-drops it to rest
    // and skips the rest gate entirely.
    const { run, down, move, up } = wired(TUCK);
    const before = run.view().cells;
    down(4, 10, 0);
    move(4, 7.9, 375);
    up(400);
    expect(run.snapshot().piecesPlaced).toBe(1); // no rest, no gate
    expect(added(run, before)).toEqual(["4,3", "4,4", "5,3", "5,4"]); // the stroke seat, hard-dropped to the overhang
    run.dispose();
  });

  test("a finger resting on a waiting placement cannot lock it out from under itself", () => {
    // The tap race: the ring is most of the way round when the finger comes back
    // down. Under the finger the wait used to keep counting and commit at the
    // 750ms mark, so the tap that followed turned the NEXT piece while the one
    // the player was holding had already locked behind it.
    const { run, down, move, up } = wired(OPEN);
    down(4, 10, 0);
    move(5.4, 10, 40); // carried two columns across the floor: a legal seat
    up(60); // settled: the gate opens on the seat on screen
    const waiting = seat(run.view().aim!.cells);
    expect(run.view().aim?.progress).toBeDefined();
    pump(42); // ≈700ms of the 750ms rest
    down(5.4, 10, 760); // the finger comes back down on the piece
    pump(6); // ≈100ms more: the gate's clock has run out twice over
    expect(run.snapshot().piecesPlaced).toBe(0); // nothing committed under it
    up(860); // a tap by the tracker's own clock: the piece rotates in place
    expect(run.snapshot().piecesPlaced).toBe(0);
    const turned = seat(run.view().aim!.cells);
    expect(turned).not.toEqual(waiting); // the seat turned, in place
    expect(run.view().aim?.progress).toBeUndefined(); // and the wait is over
    pump(60);
    expect(run.snapshot().piecesPlaced).toBe(0); // a dead gate commits nothing
    run.dispose();
  });

  test("a long press into the wait holds the piece that was pressed", () => {
    // The hold race: the press starts 200ms into the wait, so the hold window
    // (550ms) runs out before the rest (750ms) would have. The hold used to fire
    // after the commit, sending the piece AFTER the pressed one into the bay.
    const { run, down, move, up, fireHold } = wired(OPEN);
    down(4, 10, 0);
    move(5.4, 10, 40); // a legal floor seat, waiting
    up(60);
    expect(run.view().aim?.progress).toBeDefined();
    pump(12); // 200ms into the wait
    down(5.4, 10, 260);
    fireHold(); // 550ms of stillness: a long press, not a tap
    expect(run.snapshot().piecesPlaced).toBe(0);
    expect(run.snapshot().hold).toBe("Z"); // the pressed piece, in the bay
    up(900); // the held contact's release is inert
    expect(run.snapshot().piecesPlaced).toBe(0);
    run.dispose();
  });

  test("a hard drop during the wait cancels it and drops the physical piece", () => {
    // The keyboard plays the PHYSICAL piece: a key cancels every virtual
    // position — the waiting seat included — and acts on the piece itself.
    // The O here was never carried, so its physical seat is spawn; hard
    // drop drops it from spawn, not the seat the ring was promising.
    const { run, down, move, up } = wired(TUCK);
    const before = run.view().cells;
    down(4, 10, 0);
    move(4, 7.9, 40);
    up(600); // the finger rests past the dive's own window, so the seat settles
    expect(seat(run.view().aim!.cells)).toEqual(["4,0", "4,1", "5,0", "5,1"]); // the tuck, waiting
    expect(run.view().aim?.progress).toBeDefined(); // the ring is filling
    run.input("hardDrop", true);
    run.input("hardDrop", false);
    pumpUntil(() => run.snapshot().piecesPlaced === 1);
    expect(added(run, before)).toEqual(["4,3", "4,4", "5,3", "5,4"]); // spawn, dropped from spawn
    run.dispose();
  });

  test("a rotation during the wait cancels it and turns the physical piece", () => {
    // The keyboard plays the physical piece: the key takes the waiting seat
    // away and turns the falling piece itself — the O, whose rotations are
    // all the same cells, so its shadow keeps spawn's shape while the wait
    // dies. The wait is gone, so nothing commits when the ring would have
    // filled.
    const { run, down, move, up } = wired(OPEN);
    down(4, 10, 0);
    move(5.4, 10, 40);
    up(60);
    expect(run.view().aim?.progress).toBeDefined(); // the ring was filling
    run.input("rotateCW", true);
    run.input("rotateCW", false);
    expect(run.view().aim).toBeNull(); // the virtual seat is gone
    expect(run.snapshot().piecesPlaced).toBe(0);
    pump(60);
    expect(run.snapshot().piecesPlaced).toBe(0); // the cancelled wait stays cancelled
    run.dispose();
  });

  test("undo during the wait takes back the previous placement, as undo does", () => {
    // Undo is a take-back of placements, and a placement waiting out its
    // rest is not one yet: the gate dies with the undo (a key is a key),
    // and the undo itself cuts the last real boundary — on the first
    // piece there is nothing to take, and the refusal is honest.
    const first = wired(OPEN);
    first.down(4, 10, 0);
    first.move(5.4, 10, 40);
    first.up(60); // the first piece waits out its rest
    expect(first.run.undo()).toBe(false); // no placement behind it to take
    expect(first.run.snapshot().piecesPlaced).toBe(0);
    pump(60);
    expect(first.run.snapshot().piecesPlaced).toBe(0); // the dead gate commits nothing
    first.run.dispose();

    // With a placement behind it, undo takes that placement back — the
    // waiting seat's gate dies with the key, and the seat itself is not
    // spent, so only the first placement is ever cut from the log.
    const second = wired(OPEN);
    second.down(4, 10, 0);
    second.move(5.4, 10, 40);
    second.up(60);
    pumpUntil(() => second.run.snapshot().piecesPlaced === 1); // the first lands
    second.down(2, 10, 2000);
    second.move(3.4, 10, 2040);
    second.up(2060); // the second piece waits
    expect(second.run.undo()).toBe(true);
    expect(second.run.snapshot().piecesPlaced).toBe(0); // the first placement came back
    second.run.dispose();
  });

  test("the fading ring does not outrank the next drag's preview", () => {
    const { run, down, move, up } = wired(OPEN);
    down(4, 10, 0);
    move(5.4, 10, 40);
    up(60);
    pumpUntil(() => run.snapshot().piecesPlaced === 1); // the first lands; ring fades
    pump(5); // inside the 350ms fade
    const landing = seat(run.view().aim!.cells); // the ring: the seat that landed
    expect(run.view().aim?.progress).toBeGreaterThanOrEqual(1);
    down(2, 10, 3000);
    move(3.4, 10, 3040); // the next piece carried two columns across the floor
    const carried = seat(run.view().aim!.cells);
    // The live preview owns the screen. The ring is a memory of a placement that
    // already happened, and it used to paint over the drag for the whole fade.
    expect(run.view().aim?.legal).toBe(true);
    expect(run.view().aim?.progress).toBeUndefined();
    expect(carried.length).toBe(4);
    expect(carried).not.toEqual(landing); // the drag's seat, not the old ring's
    run.dispose();
  });

  test("a cancelled contact leaves nothing behind, gate or anchor", () => {
    // A drag the browser takes away: the anchor, the preview and the parked seat
    // all go. A stale anchor used to hide the piece's landing shadow for good,
    // and the next rotation brought the cancelled seat back.
    const { run, tracker, play, down, move } = wired(TUCK);
    down(4, 10, 0);
    move(4, 7.9, 40);
    play(tracker.cancel());
    expect(run.view().aim).toBeNull();
    expect(run.view().ghost.length).toBeGreaterThan(0); // the shadow speaks again
    run.input("rotateCW", true);
    run.input("rotateCW", false);
    expect(run.view().aim).toBeNull(); // the cancelled seat stays cancelled

    // The same cancel during a wait: no surviving gate to fill a ring and then
    // lock nothing. The finger comes back down on the waiting seat, and the
    // browser takes that contact away.
    const waiting = wired(OPEN);
    waiting.down(4, 10, 0);
    waiting.move(5.4, 10, 40);
    waiting.up(60); // the gate opens
    expect(waiting.run.view().aim?.progress).toBeDefined();
    waiting.down(5.4, 10, 100);
    waiting.run.contactUp(); // the adapter's cancel path, in order
    waiting.play(waiting.tracker.cancel());
    expect(waiting.run.view().aim).toBeNull();
    pump(60); // past the rest twice over
    expect(waiting.run.snapshot().piecesPlaced).toBe(0);
    waiting.run.dispose();
    run.dispose();
  });

  test("a hold swap's undo boundary is the swap, not the keyup after the placement", () => {
    // The rollover a keyboard player produces without thinking: hold down, hard
    // drop the piece it handed them, hold up. The boundary used to be recorded at
    // the keyup — after the placement — so the first undo took back nothing and
    // the second reverted the placement and the swap together.
    const { run } = wired(OPEN);
    run.input("hold", true); // Z into the bay; the J is falling
    pump(2);
    expect(run.snapshot().hold).toBe("Z");
    run.input("hardDrop", true);
    pumpUntil(() => run.snapshot().piecesPlaced === 1);
    pump(8);
    run.input("hardDrop", false);
    run.input("hold", false); // the release lands after the lock, as it does
    // Undo #1 takes back the placement: the J is back in the player's hands and
    // the bay still reads Z — the swap that handed them the J is kept.
    expect(run.undo()).toBe(true);
    expect(run.snapshot().piecesPlaced).toBe(0);
    expect(run.snapshot().hold).toBe("Z");
    // Undo #2 reverts the swap itself.
    expect(run.undo()).toBe(true);
    expect(run.snapshot().hold).toBeNull();
    run.dispose();
  });

  test("a hold release after the last trade is recorded, not dropped", () => {
    // The other half of the same boundary. The queue is nearly spent, so by the
    // time the release arrives `canSwap` has gone false — and dropping the
    // release as unwanted left the log holding a key nobody ever released,
    // which is what silently ate the swap's undo boundary.
    const { run } = wired({ ...OPEN, queue: ["Z", "J"] });
    run.input("hold", true); // Z into the bay; the J is the last piece owed
    pump(2);
    expect(run.snapshot().hold).toBe("Z");
    run.input("hardDrop", true); // spends the second-to-last piece
    pumpUntil(() => run.snapshot().piecesPlaced === 1);
    pump(8);
    run.input("hardDrop", false);
    run.input("hold", false); // the release the guard used to swallow
    // Both halves of the press are in the log: a key left down for good is a
    // board replaying a hold nobody is holding.
    expect(
      run.log().filter((event) => event.data.key === "hold").map((event) => event.type),
    ).toEqual(["keydown", "keyup"]);
    expect(run.undo()).toBe(true); // and the boundary stands where it belongs
    expect(run.snapshot().hold).toBe("Z");
    run.dispose();
  });
});
