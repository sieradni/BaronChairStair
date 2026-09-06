/**
 * Who has found ways to solve a puzzle that nobody had recorded.
 *
 * A different question from the day board next to it, and deliberately a slower
 * one. That board resets every morning and rewards playing today; this one only
 * moves when somebody finds something genuinely new, so a name on it can sit
 * there for weeks. Both are worth having and neither substitutes for the other.
 *
 * What it cannot become is a measure of who plays most. The rules that stop
 * that are in the query behind it — one credit per player per puzzle, only
 * lines that met the goal, only lines a player actually played — so this file
 * has no scoring in it at all, and could not quietly grow a second definition
 * of what counts.
 */

import type { DiscoveryRow } from "../api";
import { el, panel, replaceChildren } from "./dom";

export interface DiscoveryBoard {
  readonly element: HTMLElement;
  update(board: readonly DiscoveryRow[], selfId: string): void;
}

/**
 * What the card says before anybody has found anything.
 *
 * Said as an invitation rather than as an emptiness, because on most servers
 * this board is empty for a long time and that is not a failure state — it is
 * a standing offer.
 */
const NOTHING_FOUND = "No new lines yet. Solve a puzzle a way nobody has, and this is where it lands.";

export function createDiscoveryBoard(): DiscoveryBoard {
  const note = el("p", { class: "note", text: NOTHING_FOUND });
  const rows = el("div", { class: "board-list" });
  const element = panel("Discoveries", {}, note, rows);

  return {
    element,
    update(board, selfId) {
      note.textContent = board.length
        ? "Lines nobody had solved a puzzle with before. One per puzzle, however many you find."
        : NOTHING_FOUND;
      replaceChildren(
        rows,
        ...board.map((row, index) =>
          el(
            "div",
            {
              class:
                "board-list__row" + (row.player.id === selfId ? " board-list__row--self" : ""),
            },
            el("span", { class: "board-list__rank", text: `${index + 1}` }),
            el("span", { class: "board-list__name", text: row.player.username }),
            el("span", {
              class: "board-list__score",
              text: `${row.found} ${row.found === 1 ? "line" : "lines"}`,
            }),
          ),
        ),
      );
    },
  };
}
