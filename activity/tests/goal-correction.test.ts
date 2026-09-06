/**
 * What an officer's wording fix may and may not do to a puzzle's clear rule.
 *
 * `server/submissions.ts` states the invariant plainly: what the author solved
 * is what everybody else is held to, and a later wording fix cannot re-scope a
 * puzzle that already has runs against it. `targetAttack` is kept out of
 * `OVERRIDABLE_FIELDS` for exactly that reason.
 *
 * `withOverride` re-derives `requiredClears` from the corrected sentence, which
 * keeps the rule and the text together — right in spirit, and it had three ways
 * to lose the rule entirely and two of them said nothing. The dangerous one is
 * ordinary: `data/solutions.json` is untracked, so on a deploy box a puzzle has
 * no answer to gate a new requirement against, and every goal correction there
 * used to drop the requirement to nothing.
 *
 * A correction may *tighten* a rule, and may leave it alone. It may not quietly
 * remove it.
 */

import { describe, expect, mock, test } from "bun:test";
import { withOverride } from "../server/puzzles";
import type { ClearRequirement, Puzzle } from "../shared/puzzle";

const REQUIRED: readonly ClearRequirement[] = [{ clear: "tsd", count: 1 }];

/** A puzzle with a gated requirement and, as on a dev box, its answer to hand. */
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

function quietly<T>(run: () => T): T {
  const warn = console.warn;
  console.warn = mock(() => {});
  try {
    return run();
  } finally {
    console.warn = warn;
  }
}

const corrected = (puzzle: Puzzle, goal: string): Puzzle =>
  quietly(() => withOverride(puzzle, { title: null, author: null, goal, difficulty: null, set: null }));

describe("correcting a goal's wording", () => {
  test("leaves the rule alone when the wording did not change", () => {
    expect(corrected(WITH_ANSWER, WITH_ANSWER.goal).requiredClears).toEqual(REQUIRED);
  });

  test("keeps the rule when the new wording names nothing a count can hold", () => {
    // "Clear a TSD" -> "Clear a T-Spin Double" is the same puzzle said longer,
    // and the parser has no alias for the long form. Dropping the requirement
    // here would mean a puzzle stops demanding a TSD because somebody spelled
    // it out.
    expect(corrected(WITH_ANSWER, "Clear a T-Spin Double").requiredClears).toEqual(REQUIRED);
  });

  test("keeps the rule on a box with no answer key, which is the deploy box", () => {
    // The one that made this urgent. `data/solutions.json` is untracked, so
    // this is the ordinary production state — not a broken one — and every
    // goal correction made there used to un-enforce the puzzle silently.
    expect(corrected(NO_ANSWER, "Clear a T-Spin Double").requiredClears).toEqual(REQUIRED);
    expect(corrected(NO_ANSWER, "Clear 2 TSDs").requiredClears).toEqual(REQUIRED);
  });

  test("keeps the rule when the new wording asks more than the answer can give", () => {
    // The corrected sentence cannot be adopted — the puzzle's own solution does
    // not satisfy it — but that is a reason to refuse the new rule, not to
    // throw away the old one.
    expect(corrected(WITH_ANSWER, "Clear 3 TSDs").requiredClears).toEqual(REQUIRED);
  });

  test("adopts a corrected rule the puzzle's own answer does satisfy", () => {
    // Not a freeze for its own sake: where the new wording is countable and the
    // answer supports it, the rule follows the text.
    const wasUnenforced = {
      ...WITH_ANSWER,
      goal: "Send 4",
      requiredClears: [],
    } as unknown as Puzzle;
    const tightened = corrected(wasUnenforced, "Clear a TSD");
    expect(tightened.requiredClears).toEqual(REQUIRED);
  });

  test("a puzzle that never had a rule does not gain one it cannot meet", () => {
    const none = { ...WITH_ANSWER, requiredClears: [], solution: undefined } as unknown as Puzzle;
    expect(corrected(none, "Clear 2 TSDs").requiredClears).toEqual([]);
  });
});
