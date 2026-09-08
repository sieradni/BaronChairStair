/**
 * Answering a puzzle from the tracked archive, without ever answering the wrong
 * one.
 *
 * `data/solutions.json` is untracked, so on every ordinary deploy the served
 * puzzles carry no answer: the reveal has nothing to show, the duel reveal is
 * empty, and the reference solutions that stop a first solver being credited
 * with a discovery cannot be seeded. The answers are not actually missing from
 * those boxes — all 153 are committed inside `data/archive/puzzles.sqlite` — they
 * were simply never wired in.
 *
 * **Matched on shape, never on id.** The archive and `data/puzzles.json` are two
 * copies of the same set that have drifted: measured today, 135 of 138 agree and
 * three do not. Id 8 is "fourtris mogs" in one and "misplaced heart" in the
 * other — an id join would hand a puzzle a different puzzle's answer, which is
 * the same bad join already removed from `tools/audit-archive.ts`. A solution is
 * only adopted when the board, queue, hold and target attack it was recorded
 * against are the ones being served.
 */

import { describe, expect, test } from "bun:test";
import { shapeKey, withFallbackSolutions } from "../server/puzzles";
import type { Puzzle, SolutionStep } from "../shared/puzzle";

const ANSWER: readonly SolutionStep[] = [
  { piece: "T", cells: [[0, 0], [1, 0], [2, 0], [1, 1]], clear: "tsd", attack: 4 },
];
const OTHER: readonly SolutionStep[] = [
  { piece: "I", cells: [[0, 0], [1, 0], [2, 0], [3, 0]], clear: "quad", attack: 4 },
];

function puzzle(over: Partial<Puzzle> = {}): Puzzle {
  return {
    id: 7,
    title: "tuck the T",
    board: ["..........", ".........."],
    queue: ["T", "I"],
    hold: null,
    targetAttack: 4,
    ...over,
  } as unknown as Puzzle;
}

const bank = (p: Puzzle, answer: readonly SolutionStep[]) => new Map([[shapeKey(p), answer]]);

describe("withFallbackSolutions", () => {
  test("answers a puzzle whose shape the archive recorded", () => {
    const p = puzzle();

    const [served] = withFallbackSolutions([p], bank(p, ANSWER));

    expect(served!.solution).toEqual(ANSWER);
  });

  test("refuses a row recorded against a different board", () => {
    // The #8 case: same id, different puzzle. Adopting it would put another
    // puzzle's answer behind this one's reveal.
    const served = withFallbackSolutions([puzzle()], bank(puzzle({ board: ["TTTTTTTTTT"] }), OTHER));

    expect(served[0]!.solution).toBeUndefined();
  });

  test("refuses a row recorded against a different queue, hold or target", () => {
    const p = puzzle();
    for (const drift of [{ queue: ["I", "T"] }, { hold: "O" }, { targetAttack: 9 }]) {
      const served = withFallbackSolutions([p], bank(puzzle(drift as Partial<Puzzle>), OTHER));
      expect(served[0]!.solution).toBeUndefined();
    }
  });

  test("never overwrites an answer the box already had", () => {
    // `data/solutions.json` is the dev box's own key and is merged first. If the
    // two ever disagree the local one wins, because it is the one the rest of
    // the build was derived from.
    const p = puzzle({ solution: ANSWER } as Partial<Puzzle>);

    const [served] = withFallbackSolutions([p], bank(p, OTHER));

    expect(served!.solution).toEqual(ANSWER);
  });

  test("an empty bank changes nothing and keeps the same objects", () => {
    const p = puzzle();

    const [served] = withFallbackSolutions([p], new Map());

    expect(served).toBe(p);
  });

  test("shape ignores everything a player's answer does not depend on", () => {
    // Title, author and goal are editable by an officer and say nothing about
    // whether a recorded line still lands. Keying on them would drop a perfectly
    // good answer over a typo fix.
    expect(shapeKey(puzzle({ title: "renamed", id: 999 } as Partial<Puzzle>)))
      .toBe(shapeKey(puzzle()));
  });
});
