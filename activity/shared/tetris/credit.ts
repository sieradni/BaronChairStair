/**
 * Crediting a placement, rather than the keystrokes that happened to reach it.
 *
 * A T that ends with fewer than two front corners filled scores as a **mini**
 * unless it arrived on the fin/TST kick — so on a polymer setup
 * (https://harddrop.com/wiki/Polymer_T-Spins) one placement has two legitimate
 * scores and which you get depends on your route. The four final squares are
 * identical either way; the board cannot tell the difference.
 *
 * That asymmetry was a live bug. `RoutePlanner.placementAt` keeps the
 * highest-attack route, so a puzzle's `targetAttack` and `requiredClears` are
 * derived from the *best* route — while a player was judged on the route they
 * actually took. Four archive puzzles (#3, #6, #17, #92) were solvable only by
 * a player who happened to pick the right kick, and the reveal could not teach
 * it: `SolutionPlayer` paints final cells and has never carried a rotation.
 *
 * Worse, it was not even even-handed. A dragged placement commits through
 * `placementAt` and so silently gets the best kick; only keyboard play could
 * land the losing route. The bug punished the keyboard.
 *
 * So: a run is credited with what its placements can earn. Same cells, same
 * score, however you got there.
 *
 * **This is the one definition**, imported by the browser's runner and by the
 * server's verifier, because the client decides when a run ends and the server
 * decides what it was worth — and a run the client calls failed is never even
 * submitted.
 */

import type { ClearName, Mino as Letter } from "../puzzle";
import type { PuzzleSetup } from "./engine";
import type { Handling } from "./handling";
import type { TargetCells } from "./pathfinder";
import { replayPlacements } from "./replay";

/** A placement as it was played, with what the engine gave it at the time. */
export interface ScoredPlacement {
  readonly piece: Letter;
  readonly cells: TargetCells;
  readonly clear: ClearName | null;
  readonly attack: number;
}

/** The clears a T-spin is named by. Anything else from a T may be a lost spin. */
const T_SPIN_CLEARS: ReadonlySet<ClearName> = new Set<ClearName>(["tss", "tsd", "tst"]);

/**
 * Whether re-scoring could possibly change anything.
 *
 * Re-scoring replays every placement through the route planner, which costs
 * milliseconds and is the most expensive thing in this file — so it runs only
 * when a T cleared lines without being credited a T-spin. That is the whole
 * shape of the bug, and it covers both halves of it: the T that scored
 * `tsmini` (#6, #17, #92) and the one credited no spin at all (#3, whose worst
 * route scores a plain `double`).
 *
 * Every other run pays nothing, which is nearly every run.
 */
export function mayBeUnderCredited(placements: readonly ScoredPlacement[]): boolean {
  return placements.some(
    (placement) =>
      placement.piece === "T" && placement.clear !== null && !T_SPIN_CLEARS.has(placement.clear),
  );
}

/**
 * The placements re-scored at the best route to the same squares, or null when
 * there is nothing to change.
 *
 * Null rather than a copy on every path where the answer is "as played", so a
 * caller can tell "no change" from "changed to the same thing" without
 * comparing, and never pays to rebuild a list it already has.
 *
 * **It can only ever raise a score.** A re-score that came back lower is
 * refused outright: `placementAt` selects the highest-attack route, so a lower
 * total means the replay disagreed with the run about what happened, and the
 * player keeps what they played. A scoring rule that could take points away
 * from a run somebody already finished is not one worth having.
 */
export function creditPlacements(
  setup: PuzzleSetup,
  handling: Handling,
  placements: readonly ScoredPlacement[],
): ScoredPlacement[] | null {
  if (!mayBeUnderCredited(placements)) return null;

  let steps;
  try {
    steps = replayPlacements(
      setup,
      handling,
      placements.map(({ piece, cells }) => ({ piece, cells })),
    ).steps;
  } catch {
    // A run whose own placements will not replay. It should not happen — the
    // player just played them — but hold ordering is reconstructed rather than
    // recorded, so it is not impossible. The run stands as played.
    return null;
  }
  if (steps.length !== placements.length) return null;

  const credited = steps.map((step, index) => ({
    piece: placements[index]!.piece,
    cells: placements[index]!.cells,
    clear: step.clear,
    attack: step.attack,
  }));
  return total(credited) < total(placements) ? null : credited;
}

export function total(placements: readonly ScoredPlacement[]): number {
  return placements.reduce((sum, placement) => sum + placement.attack, 0);
}

export function clearsOf(placements: readonly ScoredPlacement[]): ClearName[] {
  return placements.flatMap((placement) => (placement.clear ? [placement.clear] : []));
}
