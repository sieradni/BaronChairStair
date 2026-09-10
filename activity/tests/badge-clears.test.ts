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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createVerdictBadge } from "../client/src/ui/results";

let window: Window;
const saved = { document: globalThis.document };

beforeAll(() => {
  window = new Window({ url: "https://local.test/" });
  globalThis.document = window.document as unknown as Document;
});

afterAll(async () => {
  globalThis.document = saved.document;
  // happy-dom holds timers, observers and the whole tree until it is told to stop.
  // Without this the window outlives the file and the process has no reason to exit.
  await window.happyDOM.close();
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

/**
 * The rules above are reproduced from `app.ts`, not imported from it — driving
 * the real thing means booting a whole page. That makes them a check on the
 * *idea* and no check at all on the code: every test in this file passes
 * whatever `app.ts` actually does with the timer.
 *
 * These three pin the parts a reproduction cannot. They are source checks for
 * the reason `tests/run-end-condition.test.ts` gives for being one: the failure
 * is an edit in a method nobody has written yet, and no fixture reaches it.
 */
describe("what app.ts actually does with the badge", () => {
  const APP = join(import.meta.dir, "..", "client", "src", "app.ts");

  test("every verdict goes through the one place that cancels a pending dismissal", () => {
    const source = readFileSync(APP, "utf8");
    // Exactly one, and it is inside `stampBadge`. The auto-dismiss is a bare
    // timer with no idea which badge it was started for, so a path that shows a
    // badge without cancelling it inherits the previous run's clock.
    const shows = [...source.matchAll(/this\.badge\.show\(/g)];

    expect(
      shows.length,
      "A badge is being shown without going through stampBadge(). The walkthrough's\n" +
        "auto-dismiss does not know which badge it was started for, so a verdict shown\n" +
        "inside its window is wiped by the previous run's timer.",
    ).toBe(1);
    expect(/private stampBadge\([^)]*\): void \{\s*this\.clearBadgeLinger\(\);/.test(source)).toBe(true);
  });

  test("disposing the app cancels a dismissal still in flight", () => {
    const source = readFileSync(APP, "utf8");
    const start = source.indexOf("  dispose(): void {");
    const body = source.slice(start, source.indexOf("\n  }", start));

    expect(
      body.includes("clearBadgeLinger"),
      "dispose() must cancel the pending auto-dismiss, or the timer fires against a\n" +
        "badge that is no longer on screen.",
    ).toBe(true);
  });

  test("the linger is long enough to read and shorter than a reader's patience", () => {
    const source = readFileSync(APP, "utf8");
    const ms = Number(/BADGE_LINGER_MS = (\d+)/.exec(source)?.[1]);

    // The duel clears at 900ms and the rush at 380ms; this one carries a score.
    expect(ms).toBeGreaterThanOrEqual(900);
    expect(ms).toBeLessThanOrEqual(3000);
  });
});
