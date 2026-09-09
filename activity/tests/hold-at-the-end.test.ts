/**
 * Holding the last piece must not conjure a new one.
 *
 * The engine needs something in the queue after the final placement or the spawn
 * crashes, so a puzzle's queue is padded with filler. `PieceLedger` already keeps
 * that filler out of the *scoring* — a lock it cannot account for ends the run —
 * but a hold swap reaches it earlier than a lock does.
 *
 * Reported from play: with the last real piece in hold, the engine swaps it into
 * the hand as the queue runs out; pressing hold again swaps it back and pulls
 * the padding into the hand, so the player is looking at a random tetromino the
 * puzzle never offered. They cannot score with it — locking it ends the run —
 * but a puzzle that appears to hand out a free piece is a puzzle whose one
 * constraint looks broken.
 *
 * A swap is only ever legitimate while the puzzle still owes *another* piece to
 * swap with. With one left there is nothing on the other side of the trade.
 */

import { describe, expect, test } from "bun:test";
import { PieceLedger } from "../shared/tetris/ledger";
import type { Mino } from "../shared/puzzle";

const ledger = (queue: Mino[], hold: Mino | null = null) => new PieceLedger(queue, hold);

describe("PieceLedger.canSwap", () => {
  test("allows a hold while more than one piece is owed", () => {
    expect(ledger(["T", "I", "O"] as Mino[]).canSwap).toBe(true);
  });

  test("counts the held piece as one of them", () => {
    // One in the queue and one in hold is still a real trade.
    expect(ledger(["T"] as Mino[], "I" as Mino).canSwap).toBe(true);
  });

  test("refuses once only one piece is left, whichever hand it is in", () => {
    expect(ledger(["T"] as Mino[]).canSwap).toBe(false);
    expect(ledger([] as Mino[], "T" as Mino).canSwap).toBe(false);
  });

  test("refuses on an empty puzzle rather than going negative", () => {
    expect(ledger([] as Mino[]).canSwap).toBe(false);
  });

  test("closes as pieces are spent, not only at the start", () => {
    // The reported case: the swap is legal early and must stop being legal by
    // the time the last piece is in hand.
    const owed = ledger(["T", "I"] as Mino[]);
    expect(owed.canSwap).toBe(true);

    owed.spend("T" as Mino);

    expect(owed.remaining).toBe(1);
    expect(owed.canSwap).toBe(false);
  });

  test("a filler lock does not re-open it", () => {
    const owed = ledger(["T"] as Mino[]);
    expect(owed.spend("O" as Mino)).toBe(false);
    expect(owed.canSwap).toBe(false);
  });
});
