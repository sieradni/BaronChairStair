/**
 * Filing what a player actually did, so the archive learns from being played.
 *
 * Every solved run already carries everything a solution row needs — the
 * placements the server derived, the log they were derived from, and the score
 * the engine gave them. This is the small decision of which of those to keep
 * and what to tell the player about it.
 *
 * The two readers pull in opposite directions and both are served by keeping
 * *more* than the leaderboard pays for. A player is credited only for a line
 * that met the goal and that nobody had recorded. A maker needs the other
 * ones — the lines that beat the target attack while missing the required
 * clears are the exact evidence that a condition says less than its sentence
 * does, and they only exist while goal enforcement is still logging rather than
 * refusing. So both are filed, and `solvedStrict` is what tells them apart.
 */

import type { Store } from "./db";
import { SOLUTION_KEY_VERSION, solutionFingerprint } from "../shared/solution-key";
import { meetsTarget, solvesPuzzle, type Puzzle, type SolutionStep } from "../shared/puzzle";
import type { InputEvent } from "../shared/tetris/verify";
import type { VerifiedRun } from "../shared/tetris/verify";
import type { Handling } from "../shared/tetris/handling";

/** What the player is told about the line they just played. */
export interface Discovery {
  /** Nobody had recorded this line before. */
  readonly isNew: boolean;
  /** Distinct lines on record for this puzzle, including this one. */
  readonly known: number;
}

export interface Finder {
  readonly playerId: string;
  readonly guildId: string | null;
}

/**
 * Records a run as a solution, if it is one worth recording.
 *
 * The bar is the *attack* target rather than the whole goal, deliberately. A
 * run that hits the number but misses the required clears is not a solve and is
 * never credited — but it is precisely what a maker is looking for, and
 * throwing it away here would mean the only way to find those is to go looking
 * with the enumerator. Filed either way; `solvedStrict` decides who gets paid.
 *
 * Returns null when there is nothing to file, so the caller can leave the
 * response shape alone rather than reporting a discovery of nothing.
 */
export function recordDiscovery(
  store: Store,
  puzzle: Puzzle,
  verified: VerifiedRun,
  events: readonly InputEvent[],
  handling: Handling,
  finder: Finder,
): Discovery | null {
  if (verified.placements.length === 0) return null;
  if (!meetsTarget(verified.attack, puzzle.targetAttack)) return null;

  const placements: SolutionStep[] = verified.placements.map((placement) => ({
    piece: placement.piece,
    cells: placement.cells,
    clear: placement.clear,
    attack: placement.attack,
  }));
  const outcome = { attack: verified.attack, clears: verified.clears };

  // Nothing here may cost a player the run they just earned. The run is already
  // recorded by the time this is called, so a throw would take the *response*
  // down while the row stands — the player sees an error, loses the verdict,
  // the solution and the leaderboard that came with it, and is told nothing
  // about a run that in fact counted. A discovery is a nicety on top of that;
  // it is never worth the run.
  //
  // Caught here rather than at the call site so every future caller inherits
  // it, and reported rather than swallowed: a store that cannot write is a real
  // fault and somebody has to be able to find it.
  let discovered = false;
  try {
    discovered = store.recordSolution({
      puzzleId: puzzle.id,
      canonicalKey: solutionFingerprint(placements, outcome),
      keyVersion: SOLUTION_KEY_VERSION,
      placements,
      // The log, so the line can be re-proved later through `verifyRun` — the
      // same path that trusted it in the first place. Replaying the placements
      // instead would reject the cleverest discoveries, which is why
      // `server/review-routes.ts` already refuses to do that.
      events,
      handling,
      attack: verified.attack,
      clears: verified.clears,
      solvedStrict: solvesPuzzle(verified.attack, verified.clears, puzzle),
      source: "player",
      foundBy: finder.playerId,
      guildId: finder.guildId,
    }).discovered;
  } catch (error) {
    console.error(
      `[discovery] could not record a solution to puzzle ${puzzle.id}: ${String(error)}`,
    );
    return null;
  }

  try {
    return { isNew: discovered, known: store.countSolutions(puzzle.id) };
  } catch (error) {
    // The row is written; only the count failed. Say what is true rather than
    // discarding a discovery that happened.
    console.error(`[discovery] could not count solutions for puzzle ${puzzle.id}: ${String(error)}`);
    return { isNew: discovered, known: 0 };
  }
}
