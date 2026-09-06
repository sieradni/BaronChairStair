/**
 * When two solutions to a puzzle are the same solution.
 *
 * The whole alternate-solution feature rests on this one question, and it fails
 * in both directions. Too strict and every rotation of an O piece is a fresh
 * discovery, so a leaderboard becomes a farming exercise. Too loose and two
 * genuinely different lines collapse into one, so the second player to find
 * something new is told it is already known.
 *
 * **The archive settles it.** Puzzle 15's goal text, written by a person long
 * before any of this, says "Clear 1 TSD (2 solutions)". Enumerating that puzzle
 * exhaustively through the real engine gives 16 distinct solutions if the key is
 * the ordered placement list, 4 if cells are sorted within each placement, and
 * **exactly 2** under the form below. Puzzle 46 — same S, Z, T queue, and whose
 * author recorded one solution — gives 1. The form agrees with the human count
 * on every puzzle whose goal text states one.
 *
 * So: the placements as a *set*, with each placement's own cells sorted, plus
 * the outcome the run actually produced.
 *
 * **Why the outcome is in the key and not merely alongside it.** The same four
 * squares reached by a different kick are a different result: measured across
 * the archive, 5 of 138 puzzles produce a different attack *and* different clear
 * names from identical cells, because a spin scores full or mini depending on
 * the route in. Puzzle 6 yields either `9|tsd,tsd` or `6|tsmini,tsd` from the
 * same placements. A key without the outcome would file a solve and a non-solve
 * as one row — and since `replayPlacements` always keeps the best-scoring route,
 * re-deriving that row later would silently promote the non-solve into a solve.
 *
 * The key is stored raw rather than hashed. Measured on the archive it is 161
 * characters at the median and 1,367 at the worst, which SQLite indexes without
 * complaint; hashing would save about 139 bytes on a row that also carries the
 * placements and the input log, and would buy a collision that reads as
 * "somebody else already found this" with nothing to compare against.
 */

import type { ClearName, SolutionStep } from "./puzzle";

/** Bumped only when the rule below changes. Stored beside every key. */
export const SOLUTION_KEY_VERSION = 1;

/** A placement as the key sees it: the piece, and where it came to rest. */
function placementKey(step: Pick<SolutionStep, "piece" | "cells" | "clear" | "attack">): string {
  // Cells sorted, because `[[3,0],[4,0]]` and `[[4,0],[3,0]]` are the same four
  // squares written two ways — a notation artifact of how a route was walked,
  // not a difference a player made. It accounts for 46% of the archive's
  // placements differing under a naive ordered key.
  const cells = [...step.cells]
    .map(([x, y]) => [Number(x), Number(y)] as const)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .map(([x, y]) => `${x},${y}`)
    .join(" ");
  // The clear and the attack this placement actually produced. Two routes to
  // the same squares can differ here, and when they do they are not the same
  // solution — one of them may not even be a solve.
  return `${step.piece}:${cells}:${step.clear ?? "-"}:${step.attack}`;
}

/**
 * The canonical key for one solution to one puzzle.
 *
 * Order-insensitive: the placements are sorted after being written, so playing
 * the same four pieces into the same four seats in a different order is the same
 * solution. That is the form the archive's own solution counts agree with.
 */
export function solutionKey(
  placements: readonly Pick<SolutionStep, "piece" | "cells" | "clear" | "attack">[],
): string {
  return placements.map(placementKey).sort().join("|");
}

/** What a stored solution is, minus the bookkeeping. */
export interface SolutionOutcome {
  readonly attack: number;
  readonly clears: readonly ClearName[];
}

/**
 * The key plus the run-level outcome, which is what a row is identified by.
 *
 * The per-placement attack already distinguishes most routes, but the run-level
 * totals catch a case the parts do not: a combo or back-to-back bonus is scored
 * against the sequence rather than against any one placement, so two orderings
 * of identical placements can send different garbage. Those orderings are the
 * same *set* and a different *result*, and the result is what a player was
 * scored on.
 */
export function solutionFingerprint(
  placements: readonly Pick<SolutionStep, "piece" | "cells" | "clear" | "attack">[],
  outcome: SolutionOutcome,
): string {
  const clears = [...outcome.clears].sort().join(",");
  return `v${SOLUTION_KEY_VERSION}|${outcome.attack}|${clears}|${solutionKey(placements)}`;
}
