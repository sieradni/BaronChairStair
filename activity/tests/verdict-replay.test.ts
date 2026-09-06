/**
 * What a filed sheet offers once it is over.
 *
 * "Try again" is withdrawn the moment a daily solves, because the run on the
 * leaderboard is the one that counts and offering to *try* again suggests it is
 * still in play. What was left was "Random puzzle" — which is not this puzzle —
 * so a player who had just solved something and wanted to play it again, to try
 * the line they thought of afterwards or to show somebody, had nowhere to go.
 *
 * So a solved sheet offers "Play again": the same puzzle, unscored.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { ClearName } from "../shared/puzzle";
import { createVerdictPanel, type VerdictHandlers } from "../client/src/ui/results";
import type { ShareFields } from "../client/src/ui/share";

let window: Window;
const saved = { document: globalThis.document };

beforeAll(() => {
  window = new Window({ url: "https://local.test/" });
  globalThis.document = window.document as unknown as Document;
});

afterAll(() => {
  globalThis.document = saved.document;
});

function fields(solved: boolean): ShareFields {
  return {
    day: 248, puzzleId: 93, solved, attack: solved ? 4 : 2, targetAttack: 4,
    durationMs: 61_200, resets: 0, piecesPlaced: 4,
    clears: (solved ? ["tsd"] : []) as readonly ClearName[],
  };
}

/** The panel, with every handler recording that it fired. */
function panelWith() {
  const fired: string[] = [];
  const handlers: VerdictHandlers = {
    onRetry: () => void fired.push("retry"),
    onReplay: () => void fired.push("replay"),
    onToggleLeaderboard: () => void fired.push("leaderboard"),
    onPractice: () => void fired.push("practice"),
    onBackToDaily: () => void fired.push("daily"),
  };
  return { panel: createVerdictPanel(handlers), fired };
}

const buttons = (el: HTMLElement) =>
  [...el.querySelectorAll("button")].map((b) => b.textContent?.trim() ?? "");

const press = (el: HTMLElement, label: string) =>
  ([...el.querySelectorAll("button")].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined)?.click();

describe("a solved sheet", () => {
  test("offers to play it again, and not to try again", () => {
    const { panel } = panelWith();
    panel.update(fields(true), null, { scored: true });
    const labels = buttons(panel.element);
    expect(labels).toContain("Play again");
    expect(labels).not.toContain("Try again");
  });

  test("pressing it replays this puzzle rather than a random one", () => {
    const { panel, fired } = panelWith();
    panel.update(fields(true), null, { scored: true });
    press(panel.element, "Play again");
    expect(fired).toEqual(["replay"]);
  });

  test("says the filed run stands, so nobody expects a better time from it", () => {
    const { panel } = panelWith();
    panel.update(fields(true), null, { scored: true });
    const replay = [...panel.element.querySelectorAll("button")]
      .find((b) => b.textContent?.trim() === "Play again");
    expect(replay?.getAttribute("title") ?? "").toContain("not recorded");
  });
});

describe("a sheet that is still the player's to file", () => {
  test("offers to try again, and not to play again", () => {
    const { panel } = panelWith();
    panel.update(fields(false), null, { scored: true });
    const labels = buttons(panel.element);
    expect(labels).toContain("Try again");
    expect(labels).not.toContain("Play again");
  });

  test("and 'Try again' still restarts the attempt rather than replaying", () => {
    const { panel, fired } = panelWith();
    panel.update(fields(false), null, { scored: true });
    press(panel.element, "Try again");
    expect(fired).toEqual(["retry"]);
  });
});

describe("an unscored practice run", () => {
  /**
   * Practice is already unscored, so a solved one still offers the replay —
   * there is nothing on a board for it to contradict.
   */
  test("a solved practice sheet can be played again too", () => {
    const { panel, fired } = panelWith();
    panel.update(fields(true), null, { scored: false });
    press(panel.element, "Play again");
    expect(fired).toEqual(["replay"]);
  });
});
