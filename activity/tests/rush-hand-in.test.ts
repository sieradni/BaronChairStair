/**
 * "Hand it in" ends a five-minute run early, and it used to do that on one
 * click, sitting in the same button row a player is already clicking through
 * while a clock runs. There is no undo: the run is filed, the remaining puzzles
 * are gone, and on a ranked rush it can only be filed once.
 *
 * So it arms first and commits second. The arming lives here rather than in the
 * panel because `bun test` has no `document` — the same split
 * `tests/duel-panel.test.ts` makes for the opponent bar, and for the same
 * reason: the rule is what is worth pinning, not the markup around it.
 *
 * The case that matters most is the third one. A button left armed by a stray
 * click must not still be armed a minute later when the player reaches for
 * something else — an expired arm re-arms rather than commits, so the second
 * click of an accidental pair can never be the one that files the run.
 */

import { describe, expect, test } from "bun:test";
import { HandInConfirm, HAND_IN_CONFIRM_MS } from "../client/src/ui/rush";

describe("HandInConfirm", () => {
  test("the first press does not hand the run in", () => {
    const guard = new HandInConfirm();

    expect(guard.press(1000)).toBe(false);
  });

  test("the first press arms it, so the panel can say so", () => {
    const guard = new HandInConfirm();
    guard.press(1000);

    expect(guard.isArmed(1000)).toBe(true);
  });

  test("a second press inside the window hands it in", () => {
    const guard = new HandInConfirm();
    guard.press(1000);

    expect(guard.press(1000 + HAND_IN_CONFIRM_MS - 1)).toBe(true);
  });

  test("a second press after the window re-arms rather than handing in", () => {
    const guard = new HandInConfirm();
    guard.press(1000);

    expect(guard.press(1000 + HAND_IN_CONFIRM_MS + 1)).toBe(false);
    expect(guard.isArmed(1000 + HAND_IN_CONFIRM_MS + 1)).toBe(true);
  });

  test("it reads as disarmed once the window has passed, with no press at all", () => {
    const guard = new HandInConfirm();
    guard.press(1000);

    expect(guard.isArmed(1000 + HAND_IN_CONFIRM_MS + 1)).toBe(false);
  });

  test("cancelling disarms it, so the next press is a first press again", () => {
    const guard = new HandInConfirm();
    guard.press(1000);
    guard.cancel();

    expect(guard.isArmed(1000)).toBe(false);
    expect(guard.press(1001)).toBe(false);
  });

  test("handing in disarms it, so a double-click cannot file twice", () => {
    const guard = new HandInConfirm();
    guard.press(1000);
    expect(guard.press(1100)).toBe(true);

    expect(guard.isArmed(1100)).toBe(false);
    expect(guard.press(1101)).toBe(false);
  });

  test("the window is long enough to read a sentence and short enough to forget", () => {
    // Pinned because both directions are real: too short and the confirmation is
    // a flicker the player never sees, too long and it is still armed when they
    // come back to the panel for something else.
    expect(HAND_IN_CONFIRM_MS).toBeGreaterThanOrEqual(2000);
    expect(HAND_IN_CONFIRM_MS).toBeLessThanOrEqual(8000);
  });
});
