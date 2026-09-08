/**
 * The reported bug, driven through a real run rather than argued about.
 *
 * "If the last piece is in hold, the game will automatically put the hold piece
 * into the player's hand, but the player can press hold again and it generates a
 * random piece."
 *
 * Observed on a two-piece puzzle, holding the first and dropping the second:
 *
 *     after dropping I   hand=O  hold=null    the auto-swap, and correct
 *     after hold again   hand=I  hold=O       the I is padding; the real O is stashed
 *
 * The padding is a real tetromino type, so "what pieces did I see" cannot tell
 * the two apart — the first version of this test asserted exactly that and passed
 * with the bug present. What distinguishes them is the *hold slot*: a legitimate
 * board has nothing in hold once the last piece has been dealt out of it, and the
 * bad swap puts the puzzle's own piece back there in exchange for filler.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { PuzzleRun } from "../client/src/game/runner";
import { type PuzzlePrompt } from "../shared/puzzle";
import { DEFAULT_HANDLING } from "../shared/tetris/handling";
import { MINO_INK } from "../client/src/render/skin";
import { pump, resetHarness, restoreClock } from "./harness";

beforeEach(() => resetHarness());
afterAll(() => restoreClock());

/** Two pieces, so holding the first leaves the second as the last one dealt. */
const PUZZLE = {
  id: 1,
  title: "the last piece",
  author: "test",
  difficulty: 1,
  goal: "place pieces",
  set: null,
  board: [],
  queue: ["O", "I"],
  hold: null,
  targetAttack: 999, // never met, so nothing ends the run early
} as unknown as PuzzlePrompt;

const newRun = () =>
  new PuzzleRun(PUZZLE, DEFAULT_HANDLING, { onFrame: () => {}, onFinish: () => {}, onLock: () => {} });

/** The falling piece, by the only identity the public view exposes: its ink. */
function inHand(run: PuzzleRun): string | null {
  const ink = run.view().activeInk;
  if (!ink) return null;
  return Object.entries(MINO_INK).find(([, value]) => value === ink)?.[0] ?? "UNKNOWN";
}

/** Hold the first piece, drop the second: the last real piece is now in hand. */
function playToTheLastPiece(): PuzzleRun {
  const run = newRun();
  run.tap("hold");
  pump(10);
  run.tap("hardDrop");
  pump(30);
  return run;
}

describe("holding once the queue has run out", () => {
  test("the last piece is dealt out of hold, leaving nothing to swap with", () => {
    const run = playToTheLastPiece();

    expect(inHand(run)).toBe("O");
    expect(run.snapshot().hold).toBeNull();
    expect(run.snapshot().piecesPlaced).toBe(1);
  });

  test("pressing hold there does not stash the puzzle's own piece for filler", () => {
    const run = playToTheLastPiece();

    run.tap("hold");
    pump(10);

    // With the bug: hand becomes the padding and hold becomes "O".
    expect(run.snapshot().hold).toBeNull();
    expect(inHand(run)).toBe("O");
  });

  test("holding repeatedly cannot get a free piece either", () => {
    const run = playToTheLastPiece();

    for (let i = 0; i < 5; i += 1) {
      run.tap("hold");
      pump(10);
    }

    expect(run.snapshot().hold).toBeNull();
    expect(inHand(run)).toBe("O");
    expect(run.snapshot().phase).toBe("playing");
  });
});
