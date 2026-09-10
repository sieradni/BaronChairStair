/**
 * Who has found ways to solve a puzzle that nobody had recorded.
 *
 * A different question from the day board next to it, and deliberately a slower
 * one. That board resets every morning and rewards playing today; this one only
 * moves when somebody finds something genuinely new, so a name on it can sit
 * there for weeks. Both are worth having and neither substitutes for the other.
 *
 * It is also the only board here that is not a club's. Every other one answers
 * "how did this server do today"; this one is a standing about the archive, and
 * the archive is the same archive wherever it is played. A club board also
 * quietly split a player's own finds the moment they played the same puzzle in
 * two servers, since `guild_id` records where a line was filed rather than who
 * found it.
 *
 * What it cannot become is a measure of who plays most. The rules that stop
 * that are in the query behind it — only lines a player actually played, only
 * ones that solved the puzzle or beat its attack target, and the unique index
 * that makes a line found twice one line — so this file has no scoring in it at
 * all, and could not quietly grow a second definition of what counts.
 */

import type { DiscoveryRow, DiscoveryStanding } from "../api";
import { el, panel, replaceChildren } from "./dom";

export interface DiscoveryBoard {
  readonly element: HTMLElement;
  update(
    board: readonly DiscoveryRow[],
    selfId: string,
    standing: DiscoveryStanding | null,
  ): void;
}

/**
 * What the card says before anybody has found anything.
 *
 * Said as an invitation rather than as an emptiness, because this board is
 * empty for a long time and that is not a failure state — it is a standing
 * offer.
 */
const NOTHING_FOUND = "No new lines yet. Solve a puzzle a way nobody has, and this is where it lands.";

const FOUND_SOMETHING =
  "Lines nobody had found before, from every server. A line counts if it solves the " +
  "puzzle or sends more attack than it asked for.";

function lines(count: number): string {
  return `${count} ${count === 1 ? "line" : "lines"}`;
}

function row(rank: number, name: string, found: number, isSelf: boolean): HTMLElement {
  return el(
    "div",
    { class: "board-list__row" + (isSelf ? " board-list__row--self" : "") },
    el("span", { class: "board-list__rank", text: `${rank}` }),
    el("span", { class: "board-list__name", text: name }),
    el("span", { class: "board-list__score", text: lines(found) }),
  );
}

export function createDiscoveryBoard(): DiscoveryBoard {
  const note = el("p", { class: "note", text: NOTHING_FOUND });
  const rows = el("div", { class: "board-list" });
  /**
   * The reader's own line, when the top of the board does not already carry it.
   *
   * Its own element under the list rather than a row appended to it: it is not
   * rank 26, and putting it inside `.board-list` would make it look like the
   * next place along.
   */
  const mine = el("div", { class: "board-list board-list--self-only", attrs: { hidden: true } });
  const element = panel("Discoveries", {}, note, rows, mine);

  return {
    element,
    update(board, selfId, standing) {
      note.textContent = board.length ? FOUND_SOMETHING : NOTHING_FOUND;
      replaceChildren(
        rows,
        ...board.map((entry, index) =>
          row(index + 1, entry.player.username, entry.found, entry.player.id === selfId),
        ),
      );
      // Only when they are not already visible above. Two rows for one person,
      // one of them labelled "you", is the reading a board gets exactly once
      // before nobody trusts it.
      const onBoard = board.some((entry) => entry.player.id === selfId);
      const show = standing !== null && !onBoard;
      mine.hidden = !show;
      replaceChildren(mine, show ? row(standing.rank, "You", standing.found, true) : null);
    },
  };
}
