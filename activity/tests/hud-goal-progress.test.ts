/**
 * What a player can see about the clears their goal demands, mid-run.
 *
 * A puzzle can now require clears and not just attack, which means the attack
 * bar no longer answers "am I done" on its own. Without a readout for the other
 * half, a player watches a full bar and a run that does not end and has nothing
 * to tell them why.
 *
 * The rows count *up* — "2 of 3" — rather than reporting the shortfall. That is
 * the same number the goal sentence above them used, moving.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { ClearName, PuzzlePrompt, RowCode } from "../shared/puzzle";
import { createHud } from "../client/src/ui/hud";

let window: Window;
const saved = { document: globalThis.document };

beforeAll(() => {
  // Scoped to this file, for the reason render.test.ts gives.
  window = new Window({ url: "https://local.test/" });
  globalThis.document = window.document as unknown as Document;
});

afterAll(() => {
  globalThis.document = saved.document;
});

const BOARD: readonly RowCode[] = ["GGG...GGGG"];

function puzzleWith(requiredClears?: { clear: ClearName; count: number }[]): PuzzlePrompt {
  return {
    id: 1, title: "Tuck the T", author: "roland", difficulty: 4,
    goal: "Clear 3 TSDs", set: null, board: BOARD,
    queue: ["T", "T", "T"], hold: null, targetAttack: 12,
    ...(requiredClears ? { requiredClears } : {}),
  } as PuzzlePrompt;
}

function snapshot(clears: readonly ClearName[], attack: number) {
  return {
    attack, targetAttack: 12, clears, hold: null, holdLocked: false,
    upcoming: [], piecesPlaced: clears.length, pieceBudget: 3,
    elapsedMs: 1000, resets: 0, phase: "running",
  } as never;
}

function hudFor(required?: { clear: ClearName; count: number }[]) {
  const hud = createHud({ onUndo: () => {}, onRedo: () => {} } as never);
  hud.setPuzzle(puzzleWith(required));
  const strip = hud.right.querySelector(".goal__progress") as HTMLElement;
  return { hud, strip };
}

const rows = (strip: HTMLElement) =>
  [...strip.querySelectorAll(".goal__need")].map((row) => ({
    label: row.getAttribute("aria-label"),
    count: row.querySelector(".goal__need-count")?.textContent,
    met: row.classList.contains("goal__need--met"),
    lit: row.querySelectorAll(".pips__dot--on").length,
    pips: row.querySelectorAll(".pips__dot").length,
  }));

describe("a puzzle that requires clears", () => {
  test("starts at none of them made", () => {
    const { strip } = hudFor([{ clear: "tsd", count: 3 }]);
    expect(strip.hidden).toBe(false);
    expect(rows(strip)).toEqual([
      { label: "0 of 3 TSD", count: "0 / 3", met: false, lit: 0, pips: 3 },
    ]);
  });

  test("counts up as the clears land, and says so to a screen reader", () => {
    const { hud, strip } = hudFor([{ clear: "tsd", count: 3 }]);
    hud.update(snapshot(["tsd"], 4));
    expect(rows(strip)[0]).toEqual({ label: "1 of 3 TSD", count: "1 / 3", met: false, lit: 1, pips: 3 });
    hud.update(snapshot(["tsd", "tsd"], 8));
    expect(rows(strip)[0]?.count).toBe("2 / 3");
    hud.update(snapshot(["tsd", "tsd", "tsd"], 12));
    expect(rows(strip)[0]).toEqual({ label: "3 of 3 TSD, done", count: "3 / 3", met: true, lit: 3, pips: 3 });
  });

  test("an overshoot reads as done, not as a fault", () => {
    // A fourth TSD on a goal of three is allowed — the rule is a floor — so the
    // row must not read "4 / 3", which looks like the tool miscounting.
    const { hud, strip } = hudFor([{ clear: "tsd", count: 3 }]);
    hud.update(snapshot(["tsd", "tsd", "tsd", "tsd"], 16));
    expect(rows(strip)[0]).toEqual({ label: "3 of 3 TSD, done", count: "3 / 3", met: true, lit: 3, pips: 3 });
  });

  test("clears the goal did not ask for do not count toward it", () => {
    // The whole bug: three quads are 12 attack and are not three TSDs.
    const { hud, strip } = hudFor([{ clear: "tsd", count: 3 }]);
    hud.update(snapshot(["quad", "quad", "quad"], 12));
    expect(rows(strip)[0]).toEqual({ label: "0 of 3 TSD", count: "0 / 3", met: false, lit: 0, pips: 3 });
  });

  test("one row per named clear, in the order the goal names them", () => {
    const { hud, strip } = hudFor([
      { clear: "tsd", count: 2 },
      { clear: "tst", count: 1 },
    ]);
    hud.update(snapshot(["tst", "tsd"], 10));
    expect(rows(strip).map((r) => r.count)).toEqual(["1 / 2", "1 / 1"]);
    expect(rows(strip).map((r) => r.met)).toEqual([false, true]);
  });

  test("a long requirement caps its pips but keeps the count exact", () => {
    const { strip } = hudFor([{ clear: "single", count: 30 }]);
    const row = rows(strip)[0]!;
    expect(row.count).toBe("0 / 30");
    expect(row.pips).toBeLessThanOrEqual(8);
    expect(strip.querySelector(".pips__plus")).not.toBeNull();
  });
});

describe("a puzzle that requires nothing", () => {
  /**
   * Which is every puzzle until `GOAL_ENFORCEMENT` is `on` — the prompt
   * withholds the requirement — so the panel must be exactly what it was.
   */
  test("shows no progress strip at all", () => {
    const { hud, strip } = hudFor(undefined);
    expect(strip.hidden).toBe(true);
    hud.update(snapshot(["quad"], 4));
    expect(strip.hidden).toBe(true);
    expect(strip.children.length).toBe(0);
  });

  test("and the attack meter still answers its own question", () => {
    const { hud } = hudFor(undefined);
    hud.update(snapshot(["quad"], 4));
    expect(hud.right.querySelector(".meter__of")?.textContent).toBe("of 12 sent");
  });
});
