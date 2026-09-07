/**
 * The clock that decides the daily leaderboard's order.
 *
 * The bug this file exists for, reported by a player: leaving the activity and
 * coming back restarted the clock. `runs.total_ms` is what the board sorts by,
 * ascending, so ten minutes of struggling followed by a reopen and a
 * thirty-second solve was filed as thirty seconds — ahead of everyone who
 * stayed. The tally of restarts went with it.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { createSittings } from "../client/src/sittings";

const DAY = 250;
const PUZZLE = 42;
const PLAYER = "player-1";

/** A localStorage good enough for these tests, and for a hostile one below. */
function installStorage(): Map<string, string> {
  const backing = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => void backing.set(k, v),
    removeItem: (k: string) => void backing.delete(k),
  };
  return backing;
}

let backing: Map<string, string>;
beforeEach(() => {
  backing = installStorage();
});

describe("leaving the activity", () => {
  test("does not restart the clock", () => {
    // The whole bug. Two stores are two app instances: the panel was closed and
    // reopened, which is the commonest thing that happens to a Discord activity.
    const before = createSittings(PLAYER);
    const opened = before.open(DAY, PUZZLE, 1_000_000);

    const after = createSittings(PLAYER);
    const resumed = after.open(DAY, PUZZLE, 1_000_000 + 10 * 60_000);

    expect(resumed.openedAt).toBe(opened.openedAt);
  });

  test("does not zero the restart tally either", () => {
    const before = createSittings(PLAYER);
    before.open(DAY, PUZZLE, 1_000);
    before.record(DAY, PUZZLE, 4);

    expect(createSittings(PLAYER).open(DAY, PUZZLE, 9_999).resets).toBe(4);
  });

  test("and a player who never left is unaffected", () => {
    const sittings = createSittings(PLAYER);
    const first = sittings.open(DAY, PUZZLE, 5_000);

    expect(sittings.open(DAY, PUZZLE, 60_000).openedAt).toBe(first.openedAt);
  });
});

describe("what still gets its own clock", () => {
  test("a different puzzle", () => {
    const sittings = createSittings(PLAYER);
    sittings.open(DAY, PUZZLE, 1_000);

    expect(sittings.open(DAY, PUZZLE + 1, 8_000).openedAt).toBe(8_000);
  });

  test("a different player on the same browser", () => {
    // One origin serves every Discord account that has opened the activity here.
    createSittings("player-a").open(DAY, PUZZLE, 1_000);

    expect(createSittings("player-b").open(DAY, PUZZLE, 7_000).openedAt).toBe(7_000);
  });

  test("the same puzzle tomorrow", () => {
    createSittings(PLAYER).open(DAY, PUZZLE, 1_000);

    expect(createSittings(PLAYER).open(DAY + 1, PUZZLE, 7_000).openedAt).toBe(7_000);
  });

  test("one deliberately forgotten, so a replay starts fresh", () => {
    const sittings = createSittings(PLAYER);
    sittings.open(DAY, PUZZLE, 1_000);

    sittings.forget(DAY, PUZZLE);

    expect(sittings.open(DAY, PUZZLE, 9_000).openedAt).toBe(9_000);
  });

  test("one forgotten by a store that has not read storage yet", () => {
    // The regression this pins, and it only appears after a reopen. `forget`
    // used to read the in-memory cache, which is empty until the first `open`
    // — and the replay path calls `forget` before any of them. So on a fresh
    // app it removed nothing, and replaying a solved daily inherited the filed
    // run's clock and restart tally: a two-minute replay reported as thirty.
    //
    // On `main` this path was safe by accident, because a new app meant an
    // empty Map. Fixing the daily's clock is what put it at risk.
    const first = createSittings(PLAYER);
    first.open(DAY, PUZZLE, 0);
    first.record(DAY, PUZZLE, 3);

    const reopened = createSittings(PLAYER);
    reopened.forget(DAY, PUZZLE);
    const replay = reopened.open(DAY, PUZZLE, 600_000);

    expect(replay.openedAt).toBe(600_000);
    expect(replay.resets).toBe(0);
  });
});

describe("when storage cannot be trusted", () => {
  test("a blocked localStorage still gives a working clock", () => {
    // Private-mode browsers throw on both read and write. The clock then
    // behaves exactly as it did before any of this existed.
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem() { throw new Error("blocked"); },
      setItem() { throw new Error("blocked"); },
      removeItem() { throw new Error("blocked"); },
    };
    const sittings = createSittings(PLAYER);

    expect(sittings.open(DAY, PUZZLE, 4_000).openedAt).toBe(4_000);
  });

  test("a corrupt record is ignored rather than repaired", () => {
    backing.set(`puzzle.sittings.v1.${PLAYER}`, "{not json");

    expect(createSittings(PLAYER).open(DAY, PUZZLE, 3_000).openedAt).toBe(3_000);
  });

  test("a hand-edited clock in the future is dropped, not honoured", () => {
    // Ascending sort: a negative elapsed time would take first place outright.
    backing.set(
      `puzzle.sittings.v1.${PLAYER}`,
      JSON.stringify({ day: DAY, sittings: { [PUZZLE]: { openedAt: "soon", resets: 1 } } }),
    );

    expect(createSittings(PLAYER).open(DAY, PUZZLE, 2_000).openedAt).toBe(2_000);
  });
});
