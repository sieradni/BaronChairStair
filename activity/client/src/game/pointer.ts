/**
 * Pointer play: tap to rotate, drag to place, long-press to hold.
 *
 * The gestures are deliberately the same on a mouse and a finger — a mouse is
 * just a finger that never loses contact — so one state machine serves both.
 * It is pure: no DOM, and every decision surfaces either as a returned
 * gesture or through the constructor's `emit`, which is what makes it testable
 * without a browser and keeps the adapter below a thin shell.
 *
 * The keyboard plays *keys*; a pointer plays *places*. A drag ends in a hard
 * drop — that is the whole meaning of letting go — so this layer never
 * synthesises soft drop or rides gravity; it only answers, at every moment,
 * which square the piece is pointed at.
 *
 * On a finger the answer is not the square under the contact. A pad covers
 * three or four squares, so aiming there would hide the target the aim exists
 * to show — the piece is aimed {@link TOUCH_LIFT_ROWS} rows above the finger
 * instead, where the player can see it. The lift is the adapter's, applied to
 * aim and commit alike and nothing else, so the preview a drag shows is
 * exactly the placement a release makes and every other gesture keeps its
 * finger-space meaning.
 *
 * Fingers also come in chords: a tap of two is an undo and a tap of three a
 * redo ({@link MultiTapTracker}). The chord counts every contact the stage
 * sees — including the one the single-finger game is playing — because the
 * primary contact of a two-finger tap is, to {@link PointerGestureTracker},
 * indistinguishable from a solo tap; the adapter suppresses that tap's
 * rotation when the chord says the contact had company. A drag or a hold
 * voids any chord, and a second finger landing re-arms the hold clock, so
 * fingers resting together never read as a long-press.
 */

export interface Spot {
  readonly column: number;
  readonly row: number;
}

/** What the tracker has decided the pointer is doing. */
export type Gesture =
  | { readonly type: "aim"; readonly spot: Spot }
  | { readonly type: "commit"; readonly spot: Spot }
  | { readonly type: "cancel" }
  | { readonly type: "rotate" }
  | { readonly type: "hold" };

/** How long a still press must sit before it is a hold, in milliseconds. */
export const HOLD_MS = 550;

/**
 * How far above the finger a touch aims, in rows.
 *
 * Three keeps the whole hollow — up to two rows of piece plus its outline —
 * clear of the pad that covers the contact. Tuned against a phone at the
 * smallest cell the narrow layout draws: three rows there is roughly the pad's
 * own height, which is what "above the finger" has to mean to be of use.
 */
export const TOUCH_LIFT_ROWS = 3;

/**
 * How long the whole of a multi-finger chord may take, first finger down to
 * last finger up, in milliseconds.
 *
 * A real two-finger tap lands and lifts inside about 150ms; 300 leaves room
 * for a deliberate third finger without reaching the hold window
 * ({@link HOLD_MS}) where a slow chord would collide with a long-press.
 */
export const TAP_CHORD_MS = 300;

/** What a completed chord asks for. */
export type ChordGesture = { readonly type: "undo" } | { readonly type: "redo" };

/**
 * Counts the contacts of a quick all-fingers-down-up chord.
 *
 * Every contact the stage sees is reported here — the one the one-finger
 * game is playing included, because that contact is exactly what a chord
 * member looks like. A chord completes when its last contact lifts, so no
 * verdict is ever speculated while fingers are still down; it is an undo at
 * two fingers, a redo at three, and nothing at one or at four-plus (four is
 * a palm, not a command). Three things void it: a contact the browser
 * cancels, a finger landing after the window has closed, and the primary
 * contact turning into a drag or a hold — the player is playing, not
 * commanding.
 *
 * The count outlives the completion until the next first-contact press
 * resets it, because the adapter needs to ask, at the primary's own release,
 * whether that contact had company — a tap that was one of several fingers
 * is not a solo tap and must not rotate.
 */
export class MultiTapTracker {
  /** Contacts now down, to their press times. */
  private members = new Map<number, number>();
  /** When the live chord's first contact landed. */
  private startedAt = 0;
  /** The most contacts the live chord held at once. */
  private peak = 0;
  /** A finger landed after the window closed; the chord is beyond saving. */
  private stray = false;
  /** A cancel or a drag/hold voided the chord; it can only wait out its members. */
  private dead = false;

  /** A contact landed. Never decides anything — chords complete on lifts. */
  press(id: number, now: number): ChordGesture | null {
    if (this.members.size === 0) {
      this.startedAt = now;
      this.peak = 0;
      this.stray = false;
      this.dead = false;
    } else if (now - this.startedAt > TAP_CHORD_MS) {
      // Too late to be part of what the first finger started.
      this.stray = true;
    }
    this.members.set(id, now);
    this.peak = Math.max(this.peak, this.members.size);
    return null;
  }

  /**
   * A contact lifted. The last one up completes the chord, for better or
   * worse; every earlier lift is just the chord losing a member.
   */
  release(id: number, now: number): ChordGesture | null {
    if (!this.members.delete(id)) return null;
    if (this.members.size > 0) return null;
    if (this.dead || this.stray || this.peak < 2) return null;
    if (now - this.startedAt > TAP_CHORD_MS) return null;
    if (this.peak === 2) return { type: "undo" };
    if (this.peak === 3) return { type: "redo" };
    return null;
  }

  /**
   * Whether the live — or just-completed — chord ever held two contacts at
   * once. The adapter reads this at the primary's release to keep a tap that
   * was one of several fingers from also rotating.
   */
  wasMulti(): boolean {
    return this.peak >= 2;
  }

  /** The browser took a contact away: anything it was part of is not a tap. */
  cancel(id: number): void {
    if (this.members.delete(id)) this.dead = true;
  }

  /**
   * The primary contact became a drag or a hold: the player is playing the
   * one-finger game, so no chord spanning it may fire. Members stay tracked
   * — their lifts are bookkeeping, not gestures.
   */
  poison(): void {
    if (this.members.size > 0) this.dead = true;
  }
}

/**
 * Lifts a touch's board square so the aim shows above the finger.
 *
 * Pure arithmetic so the clamp is testable: the lifted row saturates at the
 * top of the board rather than wrapping or refusing, because a finger on the
 * sky is still pointing at the topmost seat — clamping is what a player
 * expects of an edge, and refusing would make the top three rows of the board
 * unreachable through the gesture the lift serves.
 */
export function liftSpot(spot: Spot, lift: number, rows: number): Spot {
  return { column: spot.column, row: Math.min(spot.row + lift, rows - 1) };
}

function sameSpot(a: Spot, b: Spot): boolean {
  return a.column === b.column && a.row === b.row;
}

/**
 * The hold clock, sliced out for tests. Production arms real timers; a test
 * arms fakes it fires by hand, so "not yet" is decided by the test and not by
 * where a shared event loop happens to be when an assertion runs — a full
 * test process starves timers arbitrarily, and an assertion that reads a
 * "has not fired yet" after a starved delay is reading the past.
 */
export interface HoldClock {
  /** Arms a callback for `ms` from now; returns a token to cancel it by. */
  schedule(fn: () => void, ms: number): unknown;
  /** Disarms a scheduled callback. Cancelling an unknown token is nothing. */
  cancel(token: unknown): void;
}

const timeoutClock: HoldClock = {
  schedule: (fn, ms) => setTimeout(fn, ms),
  cancel: (token) => clearTimeout(token as ReturnType<typeof setTimeout>),
};

/**
 * The state machine behind one pointer contact.
 *
 * A press commits to nothing: the piece must not jump to the finger, or a tap
 * would teleport the piece before rotating it. Aiming begins when the contact
 * crosses into another square, which is also the tap/drag verdict — a tap
 * never leaves its square, a drag always does. A press that stays put becomes
 * a hold after {@link HOLD_MS}, emitted asynchronously; everything else is
 * decided when the contact ends.
 */
export class PointerGestureTracker {
  private origin: Spot | null = null;
  private last: Spot | null = null;
  private pressAt = 0;
  private holdTimer: unknown = null;
  /** The hold fired; the contact's eventual release is inert. */
  private holding = false;
  /** The contact left its first square; the piece is being dragged. */
  private dragging = false;

  constructor(
    private readonly emit: (gesture: Gesture) => void = () => {},
    /** Injectable so tests do not wait out a real hold. */
    private readonly holdDelay: number = HOLD_MS,
    private readonly clock: HoldClock = timeoutClock,
  ) {}

  /** A contact began at `spot` at time `now`. Nothing is decided yet. */
  press(spot: Spot, now: number): Gesture | null {
    this.origin = spot;
    this.last = spot;
    this.pressAt = now;
    this.holding = false;
    this.dragging = false;
    this.armHold();
    return null;
  }

  /**
   * The contact moved to `spot`. Aims from the moment it enters a new square —
   * including the press square again after leaving it.
   */
  move(spot: Spot): Gesture | null {
    if (!this.origin || this.holding) return null;
    this.last = spot;
    if (!this.dragging) {
      if (sameSpot(this.origin, spot)) return null;
      this.dragging = true;
      this.clearHoldTimer();
    }
    return { type: "aim", spot };
  }

  /**
   * The contact ended. A drag commits to its last square; a tap rotates; a
   * held contact has already had its say.
   */
  release(now: number): Gesture | null {
    this.clearHoldTimer();
    const { origin, last, dragging } = this;
    this.origin = null;
    this.last = null;
    this.dragging = false;
    if (this.holding) {
      this.holding = false;
      return null;
    }
    if (!origin || !last) return null;
    if (dragging) return { type: "commit", spot: last };
    // One threshold everywhere: a press held shorter than the hold window is
    // a rotate — the same window the timer fires the hold at, so a release
    // can never race it on one side in production and the other in a test.
    if (now - this.pressAt < this.holdDelay) return { type: "rotate" };
    return null;
  }

  /**
   * Re-arms the hold clock, as when a second finger lands: fingers resting
   * together are a chord in the making, not a long-press. The clock only
   * restarts while a still contact is pending — a drag has already forfeited
   * its hold and a fired hold has already had its say.
   */
  restartHold(): void {
    if (!this.origin || this.dragging || this.holding) return;
    this.clearHoldTimer();
    this.armHold();
  }

  /** The contact was taken away by the browser: a second finger, a scroll. */
  cancel(): Gesture | null {
    this.clearHoldTimer();
    const wasHolding = this.holding;
    this.origin = null;
    this.last = null;
    this.dragging = false;
    this.holding = false;
    // A held contact aimed at nothing, so there is nothing to unaim.
    return wasHolding ? null : { type: "cancel" };
  }

  private clearHoldTimer(): void {
    if (this.holdTimer !== null) {
      this.clock.cancel(this.holdTimer);
      this.holdTimer = null;
    }
  }

  private armHold(): void {
    this.holdTimer = this.clock.schedule(() => {
      this.holdTimer = null;
      // A drag that happens to be over its origin square is a drag, not a
      // hold; only a contact that never moved is.
      if (this.origin && !this.dragging) {
        this.holding = true;
        this.origin = null;
        this.last = null;
        this.emit({ type: "hold" });
      }
    }, this.holdDelay);
  }
}

export interface PointerBoard {
  /** Board square under a point in the element's local CSS pixels, or null. */
  spotAt(localX: number, localY: number): Spot | null;
  /**
   * The same square for a touch contact, or null.
   *
   * A finger is granted slack a cursor is not — a pad overhangs the card's
   * edge, and the strip under the board is where its floor seats are pressed
   * for when the target rides above the finger. Absent, every contact is read
   * through {@link spotAt}; present, it is read through this one when the
   * contact is a touch and through the other otherwise.
   */
  touchSpotAt?(localX: number, localY: number): Spot | null;
  /** The piece was aimed at a square. */
  aim(spot: Spot): void;
  /** The aim was let go of: place the piece if it can go there. */
  commit(spot: Spot): void;
  /** The piece should stop following the pointer. */
  unaim(): void;
  /** One clockwise rotation. */
  rotate(): void;
  /** Swap the falling piece into hold. */
  hold(): void;
  /** Take back the last placement. */
  undo(): void;
  /** Put back the placement undo took. */
  redo(): void;
}

/**
 * Wires the tracker to the play surface.
 *
 * The element is the stage around the board rather than the board itself: a
 * touch aims above the finger, so a floor seat is pressed for *below* the
 * board, and the contact has to begin there. The element claims its contacts
 * — `touch-action: none` in CSS keeps the browser from scrolling a drag into
 * a page pan, and the context menu is suppressed because a long-press opening
 * it mid-gesture would steal the hold. Contacts are captured by pointer id,
 * so a second finger resting on the board cannot yank the first finger's drag
 * away.
 */
export function attachPointerPlay(
  element: HTMLElement,
  board: PointerBoard,
  /**
   * Where a touch actually aims, given the square it touched. Absent, a touch
   * aims where it touched, like a mouse. Given, it applies to aim and commit —
   * the two gestures that name a place — and to nothing else, so rotate and
   * hold stay finger-space.
   */
  lift: (spot: Spot) => Spot = (spot) => spot,
  /** Injectable so tests do not wait out a real hold. */
  holdDelay: number = HOLD_MS,
  /** The hold clock, for tests that fire it by hand. */
  clock: HoldClock = timeoutClock,
): () => void {
  const chord = new MultiTapTracker();
  const apply = (gesture: Gesture | ChordGesture | null): void => {
    if (!gesture) return;
    switch (gesture.type) {
      case "aim": board.aim(gesture.spot); break;
      case "commit": board.commit(gesture.spot); break;
      case "cancel": board.unaim(); break;
      case "rotate": board.rotate(); break;
      case "hold": board.hold(); break;
      case "undo": board.undo(); break;
      case "redo": board.redo(); break;
    }
  };

  // One path for every one-finger gesture, so the rule the game owes the
  // chord holds everywhere: a contact that starts dragging or holding is
  // playing, not tapping, and voids any chord it was counted in. Aim and
  // commit return to the adapter synchronously, but hold fires through the
  // constructor's emit — both arrive here.
  const play = (gesture: Gesture | null): void => {
    if (gesture && (gesture.type === "aim" || gesture.type === "hold")) chord.poison();
    apply(gesture);
  };
  const tracker = new PointerGestureTracker(play, holdDelay, clock);
  const local = (event: PointerEvent): Spot | null => {
    const box = element.getBoundingClientRect();
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;
    const touch = event.pointerType === "touch";
    const raw = touch && board.touchSpotAt ? board.touchSpotAt(x, y) : board.spotAt(x, y);
    if (!raw) return null;
    return touch ? lift(raw) : raw;
  };
  let activeId: number | null = null;

  const onDown = (event: PointerEvent): void => {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    if (activeId !== null) {
      // A second contact: it joins the chord count and restarts the hold
      // clock — fingers resting together are not a long-press — and claims
      // nothing else, so it can steal neither the drag's aim nor its release.
      event.preventDefault();
      chord.press(event.pointerId, event.timeStamp);
      tracker.restartHold();
      return;
    }
    // Every contact counts toward a chord, mapped to a square or not: a tap
    // is about the fingers, not about where the square map can see them.
    chord.press(event.pointerId, event.timeStamp);
    const spot = local(event);
    if (!spot) return;
    event.preventDefault();
    activeId = event.pointerId;
    // Capture keeps a drag alive when the contact leaves the element mid-move.
    // It can legitimately fail — a contact released between events, an axis
    // locked by the browser — and losing it must not lose the gesture: the
    // moves keep coming while the contact is over the board either way.
    try {
      element.setPointerCapture(event.pointerId);
    } catch {
      // Play on without capture.
    }
    apply(tracker.press(spot, event.timeStamp));
  };

  const onMove = (event: PointerEvent): void => {
    if (event.pointerId !== activeId) return;
    const spot = local(event);
    if (!spot) return;
    event.preventDefault();
    play(tracker.move(spot));
  };

  const onUp = (event: PointerEvent): void => {
    const chordGesture = chord.release(event.pointerId, event.timeStamp);
    if (event.pointerId !== activeId) {
      if (chordGesture) apply(chordGesture);
      return;
    }
    activeId = null;
    event.preventDefault();
    const verdict = tracker.release(event.timeStamp);
    // A tap that was one of several fingers is not a solo tap: the chord is
    // what those fingers meant, and the rotation they would also trigger is
    // dropped. A drag still commits — the piece is where it was dragged.
    if (verdict && !(verdict.type === "rotate" && chord.wasMulti())) play(verdict);
    if (chordGesture) apply(chordGesture);
  };

  const onCancel = (event: PointerEvent): void => {
    chord.cancel(event.pointerId);
    if (event.pointerId !== activeId) return;
    activeId = null;
    apply(tracker.cancel());
  };

  const stopContextMenu = (event: Event): void => event.preventDefault();
  element.addEventListener("pointerdown", onDown);
  element.addEventListener("pointermove", onMove);
  element.addEventListener("pointerup", onUp);
  element.addEventListener("pointercancel", onCancel);
  element.addEventListener("contextmenu", stopContextMenu);

  return () => {
    element.removeEventListener("pointerdown", onDown);
    element.removeEventListener("pointermove", onMove);
    element.removeEventListener("pointerup", onUp);
    element.removeEventListener("pointercancel", onCancel);
    element.removeEventListener("contextmenu", stopContextMenu);
  };
}
