/**
 * What a rush looks like: the card that starts one, the panels that run
 * alongside it, and the sign-off when the buzzer goes.
 *
 * Everything here is built from the same pieces as the rest of the interface —
 * cream cards, a heavy caption, hard offset shadows — because a rush is another
 * way to play the same game, not a different app bolted on.
 */

import type { RushPlayed, RushRecord, RushRun, RushScope } from "../api";
import type { RushSnapshot } from "../game/rush";
import { el, formatDuration, panel, replaceChildren, stat } from "./dom";

/** Under this the countdown turns red and starts ticking in tenths. */
const URGENT_MS = 30_000;

/** Time left, in the shape you can read at a glance while playing. */
function formatClock(ms: number): string {
  const total = Math.max(0, ms);
  if (total >= URGENT_MS) {
    const seconds = Math.ceil(total / 1000);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  }
  // The last half-minute earns tenths: it is when the decision to try one more
  // puzzle or sit on the one you have is actually being made.
  return (total / 1000).toFixed(1);
}

/** Skips as pips, so how many are left reads without counting digits. */
function skipPips(left: number, total: number): string {
  return "●".repeat(Math.max(0, left)) + "○".repeat(Math.max(0, total - left));
}

// ── Handing in early ─────────────────────────────────────────────────────────

/**
 * How long an armed "Hand it in" stays armed.
 *
 * Both directions are real. Shorter and the confirmation is a flicker nobody
 * reads; longer and the button is still live when the player comes back to the
 * panel for the clock or their skip count, which is the accident it exists to
 * stop.
 */
export const HAND_IN_CONFIRM_MS = 4000;

/**
 * Two presses to end a rush, not one.
 *
 * Handing in files the run, discards the puzzles left in it, and on a ranked
 * rush can only happen once — with no undo, from a button sitting in the row a
 * player is already clicking through while a clock runs.
 *
 * The clock is passed in rather than read, so the rule can be tested without a
 * document or a fake timer: `bun test` has neither, and this is the half worth
 * pinning. The panel owns the wording and the timer that restores it.
 */
export class HandInConfirm {
  private armedAt: number | null = null;

  /** Whether the next press commits, as of `now`. */
  isArmed(now: number): boolean {
    return this.armedAt !== null && now - this.armedAt <= HAND_IN_CONFIRM_MS;
  }

  /**
   * A press. True when the caller should actually hand the run in.
   *
   * An *expired* arm re-arms rather than committing. Without that, two stray
   * clicks a minute apart would end the run between them — the very accident
   * this exists to prevent, rebuilt out of the guard meant to stop it.
   */
  press(now: number): boolean {
    if (this.isArmed(now)) {
      this.armedAt = null;
      return true;
    }
    this.armedAt = now;
    return false;
  }

  cancel(): void {
    this.armedAt = null;
  }
}

// ── The live panel ───────────────────────────────────────────────────────────

export interface RushPanel {
  readonly element: HTMLElement;
  update(snapshot: RushSnapshot, skips: number): void;
}

/**
 * @param onEnd hands the run in early. Without it a player who has spent both
 * skips on a puzzle they cannot solve has no way out but to watch the clock,
 * and what they already solved is stuck behind it.
 */
export function createRushPanel(onEnd: () => void): RushPanel {
  const clock = el("span", { class: "rush__clock", text: "5:00" });
  const solved = el("span", { class: "stat__value", text: "0" });
  const skips = el("span", { class: "stat__value rush__pips", text: "" });
  const position = el("span", { class: "stat__value", text: "1 / 40" });

  const row = (key: string, value: HTMLElement) =>
    el("div", { class: "stat" }, el("span", { class: "stat__key", text: key }), value);

  // Two presses, because handing in cannot be undone. The armed button says what
  // the second press will *do* rather than only warning that one is coming, and
  // the hint is `aria-live` so it is announced rather than merely drawn.
  const guard = new HandInConfirm();
  const handIn = el("button", {
    class: "btn btn--small",
    text: "Hand it in",
    title: "End the rush now and file what you have",
  });
  const hint = el("p", { class: "rush__hint", text: "" });
  hint.setAttribute("aria-live", "polite");
  let restore: ReturnType<typeof setTimeout> | undefined;

  const disarm = () => {
    clearTimeout(restore);
    guard.cancel();
    handIn.textContent = "Hand it in";
    handIn.classList.remove("btn--armed");
    hint.textContent = "";
  };

  handIn.addEventListener("click", () => {
    if (guard.press(Date.now())) {
      disarm();
      onEnd();
      return;
    }
    handIn.textContent = "Confirm — end the rush";
    handIn.classList.add("btn--armed");
    hint.textContent = "This files what you have solved and discards the rest.";
    clearTimeout(restore);
    restore = setTimeout(disarm, HAND_IN_CONFIRM_MS);
  });

  const element = panel(
    "Rush",
    { class: "panel--tinted" },
    el("div", { class: "rush__time" }, clock),
    row("Solved", solved),
    row("Skips", skips),
    row("Puzzle", position),
    el("div", { class: "btnrow" }, handIn),
    hint,
  );

  return {
    element,
    update(snapshot, skipBudget) {
      clock.textContent = formatClock(snapshot.remainingMs);
      clock.classList.toggle("rush__clock--urgent", snapshot.remainingMs < URGENT_MS);
      solved.textContent = String(snapshot.solved);
      skips.textContent = skipPips(snapshot.skipsLeft, skipBudget);
      position.textContent = `${snapshot.position} / ${snapshot.total}`;
    },
  };
}

// ── Starting one ─────────────────────────────────────────────────────────────

export interface RushIntroCallbacks {
  readonly onStart: (practice: boolean) => void;
  readonly onBack: () => void;
}

export interface RushIntro {
  readonly element: HTMLElement;
  update(state: { durationMs: number; skips: number; best: number; playedToday: RushRun | null }): void;
  setBusy(busy: boolean): void;
}

export function createRushIntro(callbacks: RushIntroCallbacks, skipKeyName: string): RushIntro {
  const blurb = el("p", { class: "rush__blurb", text: "" });
  const already = el("p", { class: "note", text: "" });
  already.hidden = true;
  const ranked = el("button", { class: "btn btn--primary", text: "Start today's rush" });
  const practice = el("button", { class: "btn", text: "Practice" });
  const back = el("button", { class: "btn btn--small", text: "Back to the daily" });

  ranked.addEventListener("click", () => callbacks.onStart(false));
  practice.addEventListener("click", () => callbacks.onStart(true));
  back.addEventListener("click", () => callbacks.onBack());

  const element = panel(
    "Puzzle rush",
    {},
    blurb,
    already,
    el("div", { class: "btnrow" }, ranked, practice),
    el("div", { class: "btnrow" }, back),
  );

  return {
    element,
    setBusy(busy) {
      ranked.disabled = busy;
      practice.disabled = busy;
    },
    update({ durationMs, skips, best, playedToday }) {
      const minutes = Math.round(durationMs / 60_000);
      blurb.textContent =
        `${minutes} minutes, as many puzzles as you can. A dead board just starts the ` +
        `same puzzle over, so the only way past one you cannot crack is ${skips} skips — ` +
        `press ${skipKeyName}. Everyone gets today's order.`;
      already.hidden = playedToday === null;
      if (playedToday) {
        // The button stays live. Today's rush can be played as often as you
        // like; what is spent is the scoring, not the puzzles — and being told
        // "you already played" while the stack is still there to practise on
        // was the wrong end of that.
        already.textContent =
          `Today's rush is filed: ${playedToday.solved} solved. ` +
          `Play it again as often as you like — only the first run is scored.` +
          (best > playedToday.solved ? ` Your best is ${best}.` : "");
        ranked.disabled = false;
      } else {
        ranked.disabled = false;
        if (best > 0) already.hidden = false;
        if (best > 0) already.textContent = `Your best so far: ${best} solved.`;
      }
    },
  };
}

// ── The sign-off ─────────────────────────────────────────────────────────────

export interface RushResultCard {
  readonly element: HTMLElement;
  update(result: {
    run: { solved: number; attempted: number; skipsUsed: number; timeToLastSolveMs: number };
    played: readonly RushPlayed[];
    ranked: boolean;
    isFirst: boolean;
    best: number;
  }): void;
}

export function createRushResultCard(
  onAgain: () => void,
  onBack: () => void,
  onRetry: (id: number) => void,
): RushResultCard {
  const headline = el("p", { class: "rush__headline", text: "" });
  const rows = el("div", {});
  const note = el("p", { class: "note", text: "" });
  const listNote = el("p", { class: "explore__count", text: "" });
  const list = el("div", { class: "explore__list explore__list--flow" });
  // "Again" repeats whatever was just played — the day's own stack if that is
  // what it was, practice if not. It used to always mean practice, because the
  // daily could only be played once.
  const again = el("button", { class: "btn btn--primary", text: "Play again" });
  const back = el("button", { class: "btn", text: "Back to the daily" });

  again.addEventListener("click", onAgain);
  back.addEventListener("click", onBack);

  const element = panel(
    "Rush over",
    {},
    headline,
    rows,
    note,
    listNote,
    list,
    el("div", { class: "btnrow" }, again, back),
  );

  return {
    element,
    update({ run, played, ranked, isFirst, best }) {
      headline.textContent = run.solved === 1 ? "1 solved" : `${run.solved} solved`;
      replaceChildren(
        rows,
        stat("Attempted", run.attempted),
        stat("Skips used", run.skipsUsed),
        run.solved > 0 ? stat("Last solve at", formatDuration(run.timeToLastSolveMs)) : null,
        stat("Best ever", Math.max(best, run.solved)),
      );
      note.textContent = !ranked
        ? isFirst
          ? "Practice run — nothing was filed."
          : "Not filed — the day's first run is the one that counts."
        : isFirst
          ? "Filed for today."
          : "Today's rush was already on the board, so this one was not filed.";

      // Every puzzle they actually reached, in the order they met them, and a
      // way back into any of them. Losing one to the clock is the moment you
      // most want another look at it, and until now the stack vanished with
      // the buzzer.
      // Hidden rather than empty: this is also what a run whose filing failed
      // shows, and there the list is missing because the server never answered,
      // not because nothing was played. A wrong sentence is worse than none.
      listNote.hidden = played.length === 0;
      list.hidden = played.length === 0;
      listNote.textContent = "The puzzles you played — pick one to try it again";
      replaceChildren(
        list,
        ...played.map((puzzle, index) => {
          const row = el(
            "button",
            { class: "explore__item" },
            el("span", { class: "explore__id", text: `${index + 1}` }),
            el("span", { class: "explore__title", text: puzzle.title || `sheet ${puzzle.id}` }),
            el("span", {
              class: "explore__meta",
              text: puzzle.solved ? "solved" : "not solved",
            }),
          );
          row.addEventListener("click", () => onRetry(puzzle.id));
          return row;
        }),
      );
    },
  };
}

// ── The board ────────────────────────────────────────────────────────────────

export interface RushBoard {
  readonly element: HTMLElement;
  update(entries: readonly RushRun[], selfId: string): void;
}

export function createRushBoard(): RushBoard {
  const body = el("div", { class: "board-list" });
  const element = panel("Rush board", {}, body);

  return {
    element,
    update(entries, selfId) {
      if (entries.length === 0) {
        replaceChildren(
          body,
          el("p", { class: "note", text: "Nobody has run today's rush yet. Be first." }),
        );
        return;
      }
      replaceChildren(
        body,
        ...entries.map((entry, index) =>
          el(
            "div",
            {
              class: `board-list__row${entry.player.id === selfId ? " board-list__row--self" : ""}`,
              // The tiebreak is invisible in the row itself, so it goes here
              // rather than leaving two equal-looking scores unexplained.
              title: `${entry.solved} solved · last at ${formatDuration(entry.timeToLastSolveMs)}`,
            },
            el("span", { class: "board-list__rank", text: String(index + 1) }),
            el("span", { class: "board-list__name", text: entry.player.username }),
            el("span", { class: "board-list__score", text: String(entry.solved) }),
          ),
        ),
      );
    },
  };
}

// ── The record book ──────────────────────────────────────────────────────────

export interface RushRecords {
  readonly element: HTMLElement;
  update(entries: readonly RushRecord[], scope: RushScope, selfId: string): void;
}

/**
 * Every player's best rush, ever — not today's.
 *
 * The daily board answers "who ran today" and is empty for most of a morning.
 * This one is a record book, and a record that expired at midnight would not be
 * one. Two scopes rather than two boards: the rows and the ranking are
 * identical and only the population changes, so a tab is the honest control.
 *
 * The day each record was set is on the row. Without it a board that never
 * resets reads as though everything on it happened recently, and a number
 * somebody set months ago looks like today's form.
 */
export function createRushRecords(onScope: (scope: RushScope) => void): RushRecords {
  const tabs = el("div", { class: "tiers" });
  const body = el("div", { class: "board-list" });
  const element = panel("Best ever", {}, tabs, body);

  return {
    element,
    update(entries, scope, selfId) {
      replaceChildren(
        tabs,
        ...(["global", "server"] as const).map((each) => {
          const button = el("button", {
            class: `btn btn--small tiers__pick${each === scope ? " tiers__pick--on" : ""}`,
            text: each === "global" ? "Everyone" : "This server",
          });
          button.addEventListener("click", () => onScope(each));
          return button;
        }),
      );

      if (entries.length === 0) {
        replaceChildren(
          body,
          el("p", {
            class: "note",
            text:
              scope === "server"
                ? "Nobody here has finished a rush yet."
                : "No rush has been filed anywhere yet.",
          }),
        );
        return;
      }

      replaceChildren(
        body,
        ...entries.map((entry, index) =>
          el(
            "div",
            {
              class: `board-list__row${entry.player.id === selfId ? " board-list__row--self" : ""}`,
              title: `${entry.solved} solved · last at ${formatDuration(entry.timeToLastSolveMs)}`,
            },
            el("span", { class: "board-list__rank", text: String(index + 1) }),
            el("span", { class: "board-list__name", text: entry.player.username }),
            el("span", { class: "board-list__score", text: `${entry.solved} · #${entry.day}` }),
          ),
        ),
      );
    },
  };
}
