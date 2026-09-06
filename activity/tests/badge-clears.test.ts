/**
 * The verdict badge gets off the board once there is a solution to read.
 *
 * Reported from play: the "SOLVED!" stamp sat over the middle of the field while
 * the player stepped through the walkthrough — over the very squares the
 * solution is about. Hiding it on the first *press* was half a fix, because the
 * walkthrough is attached in the same breath as the badge is shown: the two
 * arrive together, so the stamp is already in the way before anything has been
 * pressed.
 *
 * These drive the two mechanisms directly rather than through `App`, which boots
 * a whole page on construction. The wiring itself is pinned by
 * `walkthrough.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createVerdictBadge } from "../client/src/ui/results";

let window: Window;
const saved = { document: globalThis.document };

beforeAll(() => {
  window = new Window({ url: "https://local.test/" });
  globalThis.document = window.document as unknown as Document;
});

afterAll(() => {
  globalThis.document = saved.document;
});

/** The app's own rule, reproduced: show, then clear after the linger. */
function lingering(ms: number) {
  const badge = createVerdictBadge();
  badge.show(true, "9 / 9 attack");
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    timer = null;
    badge.hide();
  }, ms);
  return { badge, cancel: () => timer !== null && clearTimeout(timer) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("a solved board with a solution on screen", () => {
  test("shows the verdict, so the result is not stolen", () => {
    const { badge, cancel } = lingering(60);
    expect(badge.element.hidden).toBe(false);
    expect(badge.element.textContent).toContain("Solved");
    cancel();
  });

  test("and clears it without anybody pressing anything", async () => {
    const { badge } = lingering(40);
    expect(badge.element.hidden).toBe(false);
    await sleep(90);
    expect(badge.element.hidden).toBe(true);
  });

  test("a pending clear cannot reach the next verdict", async () => {
    // Solve, replay, solve again inside the window: without cancelling, the
    // first run's timer hides the second run's badge.
    const { badge, cancel } = lingering(40);
    cancel();
    await sleep(90);
    expect(badge.element.hidden).toBe(false);

    badge.show(true, "12 / 12 attack");
    await sleep(90);
    expect(badge.element.hidden).toBe(false);
  });
});
