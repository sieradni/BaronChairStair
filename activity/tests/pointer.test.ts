/**
 * The pointer state machine, driven without a browser.
 *
 * A gesture tracker decides what a contact *means* — aim, commit, rotate,
 * hold — and the adapter turns those verdicts into calls on the run. Fingers
 * also come in chords — a tap of two is an undo, three a redo — and the
 * {@link MultiTapTracker} that counts them is tested alongside, because the
 * chord's whole job is to stay out of the one-finger game's way. Both halves
 * are tested here headlessly, and the adapter through a happy-dom element,
 * which dispatches real PointerEvents even though it never lays anything out.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
  HOLD_MS,
  MultiTapTracker,
  PointerGestureTracker,
  TAP_CHORD_MS,
  TOUCH_CARRY,
  type Gesture,
  type Spot,
} from "../client/src/game/pointer";

const at = (column: number, row: number): Spot => ({ column, row });

/**
 * A hand-fired hold clock: deterministic where a shared event loop is not.
 * A full test process starves real timers arbitrarily, and an assertion that
 * reads a "has not fired yet" after a starved delay is reading the past —
 * this fired one of those flakes under load. Firing by token makes "not yet"
 * the test's decision instead.
 */
function fakeClock() {
  const pending = new Map<number, () => void>();
  let next = 0;
  return {
    clock: {
      schedule(fn: () => void): unknown {
        const token = ++next;
        pending.set(token, fn);
        return token;
      },
      cancel(token: unknown): void {
        pending.delete(token as number);
      },
    },
    /** Runs the callback a token was armed for, if nothing cancelled it. */
    fire(token: number): void {
      const fn = pending.get(token);
      pending.delete(token);
      fn?.();
    },
  };
}

/** Collects a tracker's gestures, with a short injected hold delay and the fake clock. */
function tracked(holdDelay = 20) {
  const gestures: Gesture[] = [];
  const fake = fakeClock();
  const tracker = new PointerGestureTracker(
    (gesture) => gestures.push(gesture),
    holdDelay,
    fake.clock,
  );
  return { tracker, gestures, fire: fake.fire };
}

const WAIT = 8;
/** Short of the injected 20ms hold window, so a release at WAIT is a rotate. */
const QUICK = WAIT;

describe("gesture tracker", () => {
  test("a press that stays put and releases quickly rotates", () => {
    const { tracker, gestures } = tracked();
    expect(tracker.press(at(4, 5), 0)).toBeNull();
    expect(tracker.release(QUICK)).toEqual({ type: "rotate" });
    expect(gestures).toEqual([]);
  });

  test("a press that leaves the origin square aims, and releasing commits", () => {
    const { tracker } = tracked();
    tracker.press(at(4, 5), 0);
    expect(tracker.move(at(5, 5))).toEqual({ type: "aim", spot: at(5, 5) });
    expect(tracker.move(at(6, 7))).toEqual({ type: "aim", spot: at(6, 7) });
    expect(tracker.release(WAIT * 2)).toEqual({ type: "commit", spot: at(6, 7) });
  });

  test("returning to the origin square keeps aiming — the verdict was already made", () => {
    const { tracker } = tracked();
    tracker.press(at(4, 5), 0);
    expect(tracker.move(at(5, 5))).toEqual({ type: "aim", spot: at(5, 5) });
    expect(tracker.move(at(4, 5))).toEqual({ type: "aim", spot: at(4, 5) });
    expect(tracker.release(QUICK * 2)).toEqual({ type: "commit", spot: at(4, 5) });
  });

  test("a press that sits still becomes a hold, not a rotate", () => {
    const { tracker, gestures, fire } = tracked();
    expect(tracker.press(at(4, 5), 0)).toBeNull();
    expect(gestures).toEqual([]);
    fire(1);
    expect(gestures).toEqual([{ type: "hold" }]);
  });

  test("a release cancels the pending hold: firing its token is nothing", () => {
    const { tracker, gestures, fire } = tracked();
    tracker.press(at(4, 5), 0);
    expect(tracker.release(QUICK)).toEqual({ type: "rotate" });
    fire(1);
    expect(gestures).toEqual([]);
  });

  test("a drag never becomes a hold, even left parked", () => {
    const { tracker, gestures, fire } = tracked();
    tracker.press(at(4, 5), 0);
    tracker.move(at(6, 5));
    fire(1); // the hold window passes; the drag had already cleared the clock
    expect(gestures).toEqual([]);
    // And the drag can still be finished.
    expect(tracker.release(WAIT * 2)).toEqual({ type: "commit", spot: at(6, 5) });
  });

  test("a held contact's release is inert, and a new press works normally", () => {
    const { tracker, gestures, fire } = tracked();
    tracker.press(at(4, 5), 0);
    fire(1);
    expect(gestures).toEqual([{ type: "hold" }]);
    expect(tracker.release(QUICK)).toBeNull();
    expect(tracker.press(at(2, 3), QUICK * 2)).toBeNull();
    expect(tracker.release(QUICK * 3)).toEqual({ type: "rotate" });
  });

  test("a held contact that the browser cancels leaves nothing to undo", () => {
    const { tracker, gestures, fire } = tracked();
    tracker.press(at(4, 5), 0);
    fire(1);
    expect(gestures).toEqual([{ type: "hold" }]);
    expect(tracker.cancel()).toBeNull();
  });

  test("a drag the browser cancels asks to unaim", () => {
    const { tracker } = tracked();
    tracker.press(at(4, 5), 0);
    tracker.move(at(7, 5));
    expect(tracker.cancel()).toEqual({ type: "cancel" });
  });

  test("moves without a press, and second presses while one is down, are ignored", () => {
    const { tracker } = tracked();
    expect(tracker.move(at(4, 5))).toBeNull();
    expect(tracker.press(at(4, 5), 0)).toBeNull();
    expect(tracker.press(at(6, 6), 1)).toBeNull();
    // The first contact still owns the state.
    expect(tracker.release(QUICK)).toEqual({ type: "rotate" });
  });

  test("a second landing re-arms the hold clock: resting fingers are not a hold", () => {
    const { tracker, gestures, fire } = tracked();
    tracker.press(at(4, 5), 0);
    tracker.restartHold(); // what a second finger's landing does
    // The original clock is gone: firing its token is nothing — this is the
    // whole property, and no wall-clock race can flake it.
    fire(1);
    expect(gestures).toEqual([]);
    // The re-armed clock is live: a genuine rest still becomes a hold.
    fire(2);
    expect(gestures).toEqual([{ type: "hold" }]);
  });

  test("restartHold leaves a drag alone, and a fired hold is not re-armed", () => {
    const { tracker, gestures, fire } = tracked();
    tracker.press(at(4, 5), 0);
    tracker.move(at(6, 5));
    tracker.restartHold(); // a drag has already forfeited its hold
    fire(1); // nothing was armed; there is no token to fire
    expect(gestures).toEqual([]);
    expect(tracker.release(WAIT * 2)).toEqual({ type: "commit", spot: at(6, 5) });

    // A hold that already fired is not re-armed into firing twice.
    const { tracker: held, gestures: heldGestures, fire: heldFire } = tracked();
    held.press(at(4, 5), 0);
    heldFire(1);
    expect(heldGestures).toEqual([{ type: "hold" }]);
    held.restartHold();
    expect(held.release(QUICK)).toBeNull();
    expect(heldGestures).toEqual([{ type: "hold" }]);
  });
});

describe("multi-finger chords", () => {
  test("a tap of two fingers is an undo, three a redo", () => {
    const chord = new MultiTapTracker();
    chord.press(1, 0);
    chord.press(2, 10);
    expect(chord.release(1, 20)).toBeNull();
    expect(chord.release(2, 30)).toEqual({ type: "undo" });

    chord.press(1, 1000);
    chord.press(2, 1010);
    chord.press(3, 1020);
    expect(chord.release(3, 1030)).toBeNull();
    expect(chord.release(2, 1040)).toBeNull();
    expect(chord.release(1, 1050)).toEqual({ type: "redo" });
  });

  test("the count is of simultaneous fingers, and a re-land keeps it", () => {
    const chord = new MultiTapTracker();
    chord.press(1, 0);
    chord.press(2, 10);
    // A third contact replaces the first before either survivor lifts.
    expect(chord.release(1, 20)).toBeNull();
    chord.press(3, 30);
    expect(chord.release(2, 40)).toBeNull();
    expect(chord.release(3, 50)).toEqual({ type: "undo" });
  });

  test("a solo tap and a palm of four name nothing", () => {
    const chord = new MultiTapTracker();
    chord.press(1, 0);
    expect(chord.release(1, 10)).toBeNull();

    chord.press(1, 100);
    chord.press(2, 100);
    chord.press(3, 100);
    chord.press(4, 100);
    expect(chord.release(4, 110)).toBeNull();
    expect(chord.release(3, 110)).toBeNull();
    expect(chord.release(2, 110)).toBeNull();
    expect(chord.release(1, 110)).toBeNull();
  });

  test("a finger landing after the window voids the chord", () => {
    const chord = new MultiTapTracker();
    chord.press(1, 0);
    chord.press(2, TAP_CHORD_MS + 1);
    expect(chord.release(1, TAP_CHORD_MS + 2)).toBeNull();
    expect(chord.release(2, TAP_CHORD_MS + 3)).toBeNull();
  });

  test("a chord that takes longer than the window to complete names nothing", () => {
    const chord = new MultiTapTracker();
    chord.press(1, 0);
    chord.press(2, 10);
    expect(chord.release(1, 20)).toBeNull();
    expect(chord.release(2, TAP_CHORD_MS + 1)).toBeNull();
  });

  test("a cancelled contact voids the chord it was counted in", () => {
    const chord = new MultiTapTracker();
    chord.press(1, 0);
    chord.press(2, 10);
    chord.cancel(2);
    expect(chord.release(1, 20)).toBeNull();
  });

  test("a drag or a hold voids the chord spanning it", () => {
    const chord = new MultiTapTracker();
    chord.press(1, 0);
    chord.press(2, 10);
    chord.poison();
    expect(chord.release(2, 20)).toBeNull();
    expect(chord.release(1, 30)).toBeNull();
    // The void holds: a late lift of a member cannot resurrect it.
    expect(chord.release(1, 40)).toBeNull();
  });

  test("chords reset: two two-finger taps are two undos", () => {
    const chord = new MultiTapTracker();
    chord.press(1, 0);
    chord.press(2, 5);
    chord.release(1, 10);
    expect(chord.release(2, 15)).toEqual({ type: "undo" });
    chord.press(1, 500);
    chord.press(2, 505);
    chord.release(2, 510);
    expect(chord.release(1, 515)).toEqual({ type: "undo" });
  });

  test("wasMulti holds until the next chord begins", () => {
    const chord = new MultiTapTracker();
    expect(chord.wasMulti()).toBe(false);
    chord.press(1, 0);
    expect(chord.wasMulti()).toBe(false);
    chord.press(2, 10);
    expect(chord.wasMulti()).toBe(true);
    chord.release(1, 20);
    chord.release(2, 30);
    // The adapter reads this at the primary's own release, so it must
    // outlive the completion that consumed the members.
    expect(chord.wasMulti()).toBe(true);
    chord.press(1, 1000);
    expect(chord.wasMulti()).toBe(false);
  });
});

describe("the touch carry", () => {
  /*
   * The carry model, Block Blast style: the first move of a drag grabs the
   * piece at the finger, and every row the finger travels moves the piece
   * TOUCH_CARRY rows — amplified in whole rows with the remainder banked, so
   * the journey is exactly the amplified one and no row is ever skipped. The
   * lift this replaces moved the piece *away* from the finger, which bought
   * visibility by spending reach: rows 0–2 became unreachable by any gesture.
   */
  /** A tracker over a 20-row board, carrying at the touch factor by default. */
  const carried = () => new PointerGestureTracker(undefined, 20, { schedule: () => 0, cancel: () => {} }, 20);

  test("the carry constant is the amplified feel, not a parity trap", () => {
    expect(TOUCH_CARRY).toBe(1.5);
  });

  test("a press aims at nothing; the first move out of its square grabs", () => {
    const t = carried();
    expect(t.press(at(4, 10), 0, TOUCH_CARRY)).toBeNull();
    expect(t.move(at(4, 10))).toBeNull(); // still on the press square
    expect(t.move(at(5, 11))).toEqual({ type: "aim", spot: at(5, 11) });
  });

  test("every row the finger travels moves the piece 1.5 rows, banked", () => {
    const t = carried();
    t.press(at(4, 10), 0, TOUCH_CARRY);
    // The grab snaps the piece to the finger's current square, not the
    // press's — the finger owns the piece from the first move (Block Blast's
    // own behaviour: what you touch is what you hold).
    expect(t.move(at(4, 11))).toEqual({ type: "aim", spot: at(4, 11) });
    // Two finger rows → +3 piece rows: the amplification, exactly.
    expect(t.move(at(4, 13))).toEqual({ type: "aim", spot: at(4, 14) });
    // One finger row → +1.5, banked: +1 now, 0.5 carried.
    expect(t.move(at(4, 14))).toEqual({ type: "aim", spot: at(4, 15) });
    // The banked 0.5 plus the next row's 1.5: two more rows down.
    expect(t.move(at(4, 15))).toEqual({ type: "aim", spot: at(4, 17) });
  });

  test("the carry clamps at the floor but keeps tracking", () => {
    const t = carried();
    t.press(at(4, 12), 0, TOUCH_CARRY);
    t.move(at(4, 13)); // grab; piece at 13
    // 4 finger rows → +6 → exactly the floor, unclamped.
    expect(t.move(at(4, 17))).toEqual({ type: "aim", spot: at(4, 19) });
    // More downward travel: the seat is already the floor, so nothing emits —
    // the piece waits at the edge for the finger to come back.
    expect(t.move(at(4, 19))).toBeNull();
    t.move(at(4, 21));
    // Reversing three finger rows from the floor: −4 amplified rows, and the
    // clamp restarted the bank so no refused overshoot replays first.
    expect(t.move(at(4, 18))).toEqual({ type: "aim", spot: at(4, 15) });
  });

  test("the carried seat follows the finger's column", () => {
    const t = carried();
    t.press(at(4, 10), 0, TOUCH_CARRY);
    t.move(at(4, 11)); // grab at 11
    expect(t.move(at(6, 12))).toEqual({ type: "aim", spot: at(6, 12) });
  });

  test("a release commits the carried seat; a never-grabbed release rotates", () => {
    const t = carried();
    t.press(at(4, 10), 0, TOUCH_CARRY);
    t.move(at(4, 11)); // grab at 11
    t.move(at(4, 13)); // +3 → 14
    expect(t.release(5)).toEqual({ type: "commit", spot: at(4, 14) });

    const tap = carried();
    tap.press(at(4, 10), 0, TOUCH_CARRY);
    expect(tap.release(5)).toEqual({ type: "rotate" });
  });

  test("a mouse carries at 1:1 — the strict drag is the carry factor of one", () => {
    const t = new PointerGestureTracker(undefined, 20, { schedule: () => 0, cancel: () => {} }, 20);
    t.press(at(4, 10), 0);
    t.move(at(4, 12)); // grab at 12
    expect(t.move(at(4, 13))).toEqual({ type: "aim", spot: at(4, 13) });
    expect(t.move(at(4, 14))).toEqual({ type: "aim", spot: at(4, 14) });
    expect(t.release(5)).toEqual({ type: "commit", spot: at(4, 14) });
  });

  test("a drag still voids the hold, and the carried seat survives a re-grab", () => {
    const t = carried();
    t.press(at(4, 10), 0, TOUCH_CARRY);
    t.move(at(4, 11)); // grabbed: the hold clock was cleared
    t.cancel(); // the browser took the contact
    // A fresh press grabs wherever the finger lands — resume by re-grab —
    // and the clamp still bounds the carried seat.
    t.press(at(4, 17), 0, TOUCH_CARRY);
    t.move(at(4, 18)); // grab at 18
    expect(t.move(at(4, 20))).toEqual({ type: "aim", spot: at(4, 19) });
  });
});

describe("the pointer adapter", () => {
  let window: Window;
  const saved = {
    document: globalThis.document,
    getComputedStyle: globalThis.getComputedStyle,
  };

  beforeAll(() => {
    // Scoped like render.test.ts: bun test shares one process and the server
    // suite leans on Bun's own fetch/Request.
    window = new Window({ url: "https://local.test/" });
    globalThis.document = window.document as unknown as Document;
    globalThis.getComputedStyle = window.getComputedStyle.bind(
      window,
    ) as unknown as typeof getComputedStyle;
  });

  afterAll(async () => {
    globalThis.document = saved.document;
    globalThis.getComputedStyle = saved.getComputedStyle;
    // Last hook in the file: happy-dom keeps its timers and its tree alive
    // until told to stop.
    await window.happyDOM.close();
  });

  /** happy-dom has no pointer capture; the adapter only sets it. */
  const element = (): HTMLElement => {
    const node = window.document.createElement("div");
    (node as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {};
    window.document.body.append(node);
    return node as unknown as HTMLElement;
  };

  function pointer(
    type: string,
    x: number,
    y: number,
    options: { pointerId?: number; button?: number; pointerType?: string } = {},
  ): PointerEvent {
    return new window.PointerEvent(type, {
      clientX: x,
      clientY: y,
      pointerId: options.pointerId ?? 1,
      button: options.button ?? 0,
      pointerType: options.pointerType ?? "touch",
      bubbles: true,
    }) as unknown as PointerEvent;
  }

  test("tap rotates, drag aims and commits, right-click is ignored", async () => {
    const { attachPointerPlay } = await import("../client/src/game/pointer");
    const node = element();
    const box = { left: 10, top: 20 };
    node.getBoundingClientRect = () => box as DOMRect;
    const calls: string[] = [];
    let aim: Spot | null = null;
    const detach = attachPointerPlay(node, {
      spotAt: (x, y) => ({ column: Math.floor(x / 20), row: 9 - Math.floor(y / 20) }),
      aim: (spot) => {
        aim = spot;
        calls.push(`aim:${spot.column},${spot.row}`);
      },
      commit: (spot) => calls.push(`commit:${spot.column},${spot.row}`),
      unaim: () => calls.push("unaim"),
      rotate: () => calls.push("rotate"),
      hold: () => calls.push("hold"),
      undo: () => calls.push("undo"),
      redo: () => calls.push("redo"),
    });

    // spotAt receives coordinates the adapter has already made local.
    // A right-click never starts a gesture.
    node.dispatchEvent(pointer("pointerdown", 25, 25, { button: 2, pointerType: "mouse" }));
    // A tap: down and up on the same square (cell 0, row 9).
    node.dispatchEvent(pointer("pointerdown", 25, 25));
    node.dispatchEvent(pointer("pointerup", 25, 25));
    expect(calls).toEqual(["rotate"]);
    expect(aim).toBeNull();

    // A drag to the neighbouring cell (1, 9), then let go.
    node.dispatchEvent(pointer("pointerdown", 25, 25));
    node.dispatchEvent(pointer("pointermove", 45, 25));
    expect(calls).toEqual(["rotate", "aim:1,9"]);
    node.dispatchEvent(pointer("pointerup", 45, 25));
    expect(calls).toEqual(["rotate", "aim:1,9", "commit:1,9"]);

    detach();
  });

  test("a touch carries the piece farther than the finger; a mouse tracks 1:1", async () => {
    const { attachPointerPlay } = await import("../client/src/game/pointer");
    const node = element();
    node.getBoundingClientRect = () => ({ left: 0, top: 0 }) as DOMRect;
    const calls: string[] = [];
    // The touch map is the app's: on the card the strict square, beside or
    // below it the nearest square — every sample clamped into the board, so
    // a drag may leave the card without the piece losing its seat. Cell is
    // 20px; the board is 10 by 10.
    const detach = attachPointerPlay(node, {
      spotAt: (x, y) => ({ column: Math.floor(x / 20), row: 9 - Math.floor(y / 20) }),
      touchSpotAt: (x, y) => ({
        column: Math.max(0, Math.min(9, Math.floor(x / 20))),
        row: Math.max(0, Math.min(9, 9 - Math.floor(y / 20))),
      }),
      aim: (spot) => calls.push(`aim:${spot.column},${spot.row}`),
      commit: (spot) => calls.push(`commit:${spot.column},${spot.row}`),
      unaim: () => calls.push("unaim"),
      rotate: () => calls.push("rotate"),
      hold: () => calls.push("hold"),
      undo: () => calls.push("undo"),
      redo: () => calls.push("redo"),
    });

    // The same two-row finger drag, both pointers: the touch's piece lands
    // one and a half times farther than the mouse's — the amplification,
    // visible through the adapter. Both grab at (2,8); the touch carries
    // −3 rows to row 5, the mouse −2 to row 6.
    node.dispatchEvent(pointer("pointerdown", 25, 25, { pointerType: "touch" }));
    node.dispatchEvent(pointer("pointermove", 45, 25, { pointerType: "touch" }));
    node.dispatchEvent(pointer("pointermove", 45, 65, { pointerType: "touch" }));
    expect(calls).toEqual(["aim:2,8", "aim:2,5"]);
    node.dispatchEvent(pointer("pointerup", 45, 65, { pointerType: "touch" }));
    expect(calls).toEqual(["aim:2,8", "aim:2,5", "commit:2,5"]);

    calls.length = 0;
    node.dispatchEvent(pointer("pointerdown", 25, 25, { pointerType: "mouse" }));
    node.dispatchEvent(pointer("pointermove", 45, 25, { pointerType: "mouse" }));
    node.dispatchEvent(pointer("pointermove", 45, 65, { pointerType: "mouse" }));
    node.dispatchEvent(pointer("pointerup", 45, 65, { pointerType: "mouse" }));
    expect(calls).toEqual(["aim:2,8", "aim:2,6", "commit:2,6"]);

    // A finger that drags far past the board's bottom edge: every sample
    // clamps to the floor, the carried seat waits there, and the release
    // commits the floor seat it showed.
    calls.length = 0;
    node.dispatchEvent(pointer("pointerdown", 25, 45, { pointerType: "touch" }));
    node.dispatchEvent(pointer("pointermove", 45, 45, { pointerType: "touch" }));
    node.dispatchEvent(pointer("pointermove", 45, 400, { pointerType: "touch" }));
    node.dispatchEvent(pointer("pointerup", 45, 400, { pointerType: "touch" }));
    expect(calls).toEqual(["aim:2,7", "aim:2,0", "commit:2,0"]);

    detach();
  });

  test("a tap never aims, lifted or not", async () => {
    const { attachPointerPlay } = await import("../client/src/game/pointer");
    const node = element();
    node.getBoundingClientRect = () => ({ left: 0, top: 0 }) as DOMRect;
    const calls: string[] = [];
    const detach = attachPointerPlay(node, {
      spotAt: () => at(3, 4),
      touchSpotAt: () => at(3, 0),
      aim: () => calls.push("aim"),
      commit: () => calls.push("commit"),
      unaim: () => calls.push("unaim"),
      rotate: () => calls.push("rotate"),
      hold: () => calls.push("hold"),
      undo: () => calls.push("undo"),
      redo: () => calls.push("redo"),
    });
    node.dispatchEvent(pointer("pointerdown", 10, 10));
    node.dispatchEvent(pointer("pointerup", 10, 10));
    expect(calls).toEqual(["rotate"]);
    detach();
  });

  test("a two-finger tap is an undo, not a rotate and not two gestures", async () => {
    const { attachPointerPlay } = await import("../client/src/game/pointer");
    const node = element();
    node.getBoundingClientRect = () => ({ left: 0, top: 0 }) as DOMRect;
    const calls: string[] = [];
    const detach = attachPointerPlay(node, {
      spotAt: () => at(3, 4),
      aim: () => calls.push("aim"),
      commit: () => calls.push("commit"),
      unaim: () => calls.push("unaim"),
      rotate: () => calls.push("rotate"),
      hold: () => calls.push("hold"),
      undo: () => calls.push("undo"),
      redo: () => calls.push("redo"),
    });

    node.dispatchEvent(pointer("pointerdown", 10, 10, { pointerId: 1 }));
    node.dispatchEvent(pointer("pointerdown", 30, 30, { pointerId: 2 }));
    // The first finger lifts, and only then the second.
    node.dispatchEvent(pointer("pointerup", 10, 10, { pointerId: 1 }));
    node.dispatchEvent(pointer("pointerup", 10, 10, { pointerId: 2 }));
    // The chord is the whole meaning of those two fingers: one undo, and the
    // rotation the primary's tap would otherwise also fire is dropped.
    expect(calls).toEqual(["undo"]);
    detach();
  });

  test("the primary lifting first still completes the chord", async () => {
    const { attachPointerPlay } = await import("../client/src/game/pointer");
    const node = element();
    node.getBoundingClientRect = () => ({ left: 0, top: 0 }) as DOMRect;
    const calls: string[] = [];
    const detach = attachPointerPlay(node, {
      spotAt: () => at(3, 4),
      aim: () => calls.push("aim"),
      commit: () => calls.push("commit"),
      unaim: () => calls.push("unaim"),
      rotate: () => calls.push("rotate"),
      hold: () => calls.push("hold"),
      undo: () => calls.push("undo"),
      redo: () => calls.push("redo"),
    });

    node.dispatchEvent(pointer("pointerdown", 10, 10, { pointerId: 1 }));
    node.dispatchEvent(pointer("pointerdown", 30, 30, { pointerId: 2 }));
    node.dispatchEvent(pointer("pointerup", 30, 30, { pointerId: 2 }));
    node.dispatchEvent(pointer("pointerup", 10, 10, { pointerId: 1 }));
    expect(calls).toEqual(["undo"]);
    detach();
  });

  test("a three-finger tap is a redo", async () => {
    const { attachPointerPlay } = await import("../client/src/game/pointer");
    const node = element();
    node.getBoundingClientRect = () => ({ left: 0, top: 0 }) as DOMRect;
    const calls: string[] = [];
    const detach = attachPointerPlay(node, {
      spotAt: () => at(3, 4),
      aim: () => calls.push("aim"),
      commit: () => calls.push("commit"),
      unaim: () => calls.push("unaim"),
      rotate: () => calls.push("rotate"),
      hold: () => calls.push("hold"),
      undo: () => calls.push("undo"),
      redo: () => calls.push("redo"),
    });

    for (const id of [1, 2, 3]) {
      node.dispatchEvent(pointer("pointerdown", 10 * id, 10, { pointerId: id }));
    }
    for (const id of [3, 2, 1]) {
      node.dispatchEvent(pointer("pointerup", 10 * id, 10, { pointerId: id }));
    }
    expect(calls).toEqual(["redo"]);
    detach();
  });

  test("a chord works with every finger off the board", async () => {
    const { attachPointerPlay } = await import("../client/src/game/pointer");
    const node = element();
    node.getBoundingClientRect = () => ({ left: 0, top: 0 }) as DOMRect;
    const calls: string[] = [];
    const detach = attachPointerPlay(node, {
      // No square under anything: the chord is about the fingers, not the map.
      spotAt: () => null,
      aim: () => calls.push("aim"),
      commit: () => calls.push("commit"),
      unaim: () => calls.push("unaim"),
      rotate: () => calls.push("rotate"),
      hold: () => calls.push("hold"),
      undo: () => calls.push("undo"),
      redo: () => calls.push("redo"),
    });

    node.dispatchEvent(pointer("pointerdown", 5, 400, { pointerId: 1 }));
    node.dispatchEvent(pointer("pointerdown", 60, 400, { pointerId: 2 }));
    node.dispatchEvent(pointer("pointerup", 5, 400, { pointerId: 1 }));
    node.dispatchEvent(pointer("pointerup", 60, 400, { pointerId: 2 }));
    expect(calls).toEqual(["undo"]);
    detach();
  });

  test("a drag with a second finger resting commits instead of undoing", async () => {
    const { attachPointerPlay } = await import("../client/src/game/pointer");
    const node = element();
    node.getBoundingClientRect = () => ({ left: 0, top: 0 }) as DOMRect;
    const calls: string[] = [];
    const detach = attachPointerPlay(node, {
      spotAt: (x) => ({ column: Math.floor(x / 20), row: 9 }),
      aim: () => calls.push("aim"),
      commit: () => calls.push("commit"),
      unaim: () => calls.push("unaim"),
      rotate: () => calls.push("rotate"),
      hold: () => calls.push("hold"),
      undo: () => calls.push("undo"),
      redo: () => calls.push("redo"),
    });

    node.dispatchEvent(pointer("pointerdown", 10, 10, { pointerId: 1 }));
    node.dispatchEvent(pointer("pointerdown", 30, 30, { pointerId: 2 }));
    node.dispatchEvent(pointer("pointermove", 50, 10, { pointerId: 1 }));
    node.dispatchEvent(pointer("pointerup", 50, 10, { pointerId: 1 }));
    node.dispatchEvent(pointer("pointerup", 30, 30, { pointerId: 2 }));
    // The primary was playing, not tapping: the drag lands, the chord is void.
    expect(calls).toEqual(["aim", "commit"]);
    detach();
  });

  test("two fingers resting together are not a long-press", async () => {
    const { attachPointerPlay } = await import("../client/src/game/pointer");
    const node = element();
    node.getBoundingClientRect = () => ({ left: 0, top: 0 }) as DOMRect;
    const calls: string[] = [];
    const fake = fakeClock();
    const detach = attachPointerPlay(
      node,
      {
        spotAt: () => at(3, 4),
        aim: () => calls.push("aim"),
        commit: () => calls.push("commit"),
        unaim: () => calls.push("unaim"),
        rotate: () => calls.push("rotate"),
        hold: () => calls.push("hold"),
        undo: () => calls.push("undo"),
        redo: () => calls.push("redo"),
      },
      HOLD_MS,
      fake.clock,
    );

    node.dispatchEvent(pointer("pointerdown", 10, 10, { pointerId: 1 }));
    node.dispatchEvent(pointer("pointerdown", 30, 30, { pointerId: 2 })); // re-arms
    // The first finger's clock is gone — firing its token is nothing. This is
    // the whole property, proven without a single real timer.
    fake.fire(1);
    expect(calls).toEqual([]);
    // The re-armed clock is live: a genuine rest does become a hold.
    fake.fire(2);
    expect(calls).toEqual(["hold"]);
    // Releases afterwards are inert, and the poisoned chord names nothing.
    node.dispatchEvent(pointer("pointerup", 10, 10, { pointerId: 1 }));
    node.dispatchEvent(pointer("pointerup", 30, 30, { pointerId: 2 }));
    expect(calls).toEqual(["hold"]);
    detach();
  });

  test("the context menu is suppressed", async () => {
    const { attachPointerPlay } = await import("../client/src/game/pointer");
    const node = element();
    node.getBoundingClientRect = () => ({ left: 0, top: 0 }) as DOMRect;
    let defaultPrevented = false;
    const event = new window.Event("contextmenu", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "preventDefault", {
      value: () => {
        defaultPrevented = true;
      },
    });
    const detach = attachPointerPlay(node as unknown as HTMLElement, {
      spotAt: () => null,
      aim: () => {},
      commit: () => {},
      unaim: () => {},
      rotate: () => {},
      hold: () => {},
      undo: () => {},
      redo: () => {},
    });
    node.dispatchEvent(event as unknown as Event);
    expect(defaultPrevented).toBe(true);
    detach();
  });
});
