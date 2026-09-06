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
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

/**
 * The one property that makes "Play again" safe, guarded where it can actually
 * fail.
 *
 * The panel tests above prove the button is offered, labelled and wired. None of
 * them can fail if the replay starts being *scored* — and that is the whole risk
 * of the feature: a scored replay would file a run against today's puzzle and
 * move the leaderboard the filed run already sits on. Sabotaging
 * `scored: false` to `true` leaves all six of them passing.
 *
 * A source check rather than a behavioural one, for the same reason
 * `tests/run-end-condition.test.ts` is one: exercising it would mean driving the
 * whole `App` through a session, a fetch and a board, and the failure mode is a
 * one-word edit in a method nobody has written yet.
 */
describe("a replay cannot become a scored run", () => {
  const APP = join(import.meta.dir, "..", "client", "src", "app.ts");

  function bodyOf(source: string, name: string): string {
    const start = source.indexOf(`private async ${name}(`);
    expect(start, `${name} is gone from app.ts — this guard needs rewriting`).toBeGreaterThan(-1);
    // To the next method at the same indentation, which is where this one ends.
    const rest = source.slice(start);
    const next = rest.slice(1).search(/\n  (?:private|public|protected)?\s*(?:async\s+)?[a-zA-Z]+\(/);
    return next === -1 ? rest : rest.slice(0, next + 1);
  }

  test("the replay goes through the path that opens a puzzle unscored", () => {
    const source = readFileSync(APP, "utf8");
    const replay = bodyOf(source, "replaySheet");

    // Not `startRun()`, which re-runs the sheet as it is — and a filed daily
    // sheet is a scored one.
    expect(
      replay.includes("openArchivePuzzle"),
      "replaySheet must route through openArchivePuzzle, which is the path that\n" +
        "sets `scored: false`. Calling startRun() here would replay today's sheet\n" +
        "as a scored run and let a practice go overwrite the filed one.",
    ).toBe(true);
  });

  test("and it starts its own clock rather than the filed run's", () => {
    const source = readFileSync(APP, "utf8");
    const replay = bodyOf(source, "replaySheet");

    // `sittings` is keyed by puzzle, so replaying the same one inherits the
    // filed run's openedAt and restart tally and the practice card reports a
    // time nobody played.
    expect(
      /sittings\.delete\(/.test(replay),
      "replaySheet must clear this puzzle's sitting, or the replay inherits the\n" +
        "clock and restart tally of the run already filed against it.",
    ).toBe(true);
  });

  test("and that path marks the sheet unscored", () => {
    const source = readFileSync(APP, "utf8");
    const open = bodyOf(source, "openArchivePuzzle");

    expect(
      /scored:\s*false/.test(open),
      "openArchivePuzzle no longer sets `scored: false`. Every caller of it —\n" +
        "the explorer, random practice, the rush card, and Play again — depends\n" +
        "on that to keep a practice run off the leaderboard.",
    ).toBe(true);
    expect(/scored:\s*true/.test(open)).toBe(false);
  });
});
