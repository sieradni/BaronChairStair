/**
 * What an officer's wording fix may and may not do to a puzzle's clear rule.
 *
 * The answer is now: nothing, ever. The requirement is read off the puzzle's own
 * replayed solution, so the sentence beside it is a description and not a
 * source. An officer rewriting a goal is fixing how the puzzle *reads*; they are
 * not re-scoping what it demands, any more than they can edit `targetAttack` —
 * which is kept out of `OVERRIDABLE_FIELDS` for the same reason, and which
 * `server/submissions.ts` states plainly: what the author solved is what
 * everybody else is held to.
 *
 * This file used to test the opposite half of a subtler rule. `withOverride`
 * re-derived the requirement from the corrected sentence, gated on the answer
 * still satisfying it, and that gate had three ways to lose the rule silently —
 * the dangerous one being a deploy box, where `data/solutions.json` is untracked
 * and every correction therefore un-enforced the puzzle. Deriving from the
 * answer instead removes the gate and the failure together: there is no longer
 * any path by which editing prose changes a rule.
 */

import { describe, expect, test } from "bun:test";
import { withOverride } from "../server/puzzles";
import type { ClearRequirement, Puzzle } from "../shared/puzzle";

const REQUIRED: readonly ClearRequirement[] = [{ clear: "tsd", count: 1 }];

/** A puzzle with a requirement and, as on a dev box, its answer to hand. */
const WITH_ANSWER = {
  id: 42,
  title: "tuck the T",
  author: "someone",
  difficulty: 5,
  goal: "Clear a TSD",
  set: null,
  board: [],
  queue: ["T"],
  hold: null,
  targetAttack: 4,
  requiredClears: REQUIRED,
  solution: [{ piece: "T", cells: [], clear: "tsd", attack: 4 }],
} as unknown as Puzzle;

/** The same puzzle as a deploy box sees it: no `data/solutions.json` merged in. */
const NO_ANSWER = { ...WITH_ANSWER, solution: undefined } as unknown as Puzzle;

const corrected = (puzzle: Puzzle, goal: string): Puzzle =>
  withOverride(puzzle, { title: null, author: null, goal, difficulty: null, set: null });

describe("correcting a goal's wording", () => {
  test("applies the new wording to the goal the player reads", () => {
    expect(corrected(WITH_ANSWER, "Clear a T-Spin Double").goal).toBe("Clear a T-Spin Double");
  });

  test("leaves the rule alone when the wording did not change", () => {
    expect(corrected(WITH_ANSWER, WITH_ANSWER.goal).requiredClears).toEqual(REQUIRED);
  });

  test("leaves the rule alone when the new wording names nothing countable", () => {
    expect(corrected(WITH_ANSWER, "make it look nice").requiredClears).toEqual(REQUIRED);
  });

  test("leaves the rule alone on a box with no answer key, which is the deploy box", () => {
    expect(corrected(NO_ANSWER, "Clear a T-Spin Double").requiredClears).toEqual(REQUIRED);
    expect(corrected(NO_ANSWER, "Clear 2 TSDs").requiredClears).toEqual(REQUIRED);
  });

  test("cannot tighten the rule, however countable the new sentence is", () => {
    // The wording may now ask for three; the puzzle still demands what its
    // answer plays. Otherwise one edit makes a puzzle unsolvable for everybody,
    // including by its own reference solution, from the next restart.
    expect(corrected(WITH_ANSWER, "Clear 3 TSDs").requiredClears).toEqual(REQUIRED);
  });

  test("cannot loosen the rule either", () => {
    expect(corrected(WITH_ANSWER, "Send 4").requiredClears).toEqual(REQUIRED);
  });

  test("cannot grant a rule to a puzzle that has none", () => {
    const none = { ...WITH_ANSWER, requiredClears: [] } as unknown as Puzzle;
    expect(corrected(none, "Clear a TSD").requiredClears).toEqual([]);
  });
});
