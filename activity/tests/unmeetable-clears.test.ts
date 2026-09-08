/**
 * The last gate: a puzzle may not demand a clear its own answer never makes.
 *
 * Three places can freeze a clear requirement — the archive backfill, an
 * accepted submission, and an officer's goal correction — and all three check
 * the requirement against the author's answer before writing it. That is three
 * independent gates holding one opinion, and each of them can only see the
 * moment it runs. None can see a puzzle that goes bad *afterwards*: a creator
 * edits a published puzzle (the archive records exactly this and voids the
 * discoveries), a row is hand-fixed in sqlite, a backup is restored from before
 * a re-solve.
 *
 * So the rule is stated once more where every puzzle passes on its way to a
 * player, whatever it came from: if the recorded answer cannot meet the frozen
 * requirement, the puzzle serves with **no clear requirement at all** and is
 * scored on attack alone.
 *
 * Attack is never touched. `targetAttack` is derived from the answer and is the
 * bar a run is actually filed against; a puzzle that is wrong about its clears
 * is not thereby wrong about its damage.
 */

import { describe, expect, mock, test } from "bun:test";
import { withoutUnmeetableClears } from "../server/puzzles";
import type { ClearRequirement, Puzzle } from "../shared/puzzle";

const REQUIRED: readonly ClearRequirement[] = [{ clear: "tsd", count: 1 }];

/** A puzzle whose answer makes exactly what its requirement asks for. */
const HONEST = {
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

/** The same puzzle after its answer moved: the TSD is now a mini. */
const DRIFTED = {
  ...HONEST,
  solution: [{ piece: "T", cells: [], clear: "tsmini", attack: 4 }],
} as unknown as Puzzle;

/** As a deploy box sees it: `data/solutions.json` is untracked and absent. */
const NO_ANSWER = { ...DRIFTED, solution: undefined } as unknown as Puzzle;

function warnings(run: () => void): string[] {
  const real = console.warn;
  const said: string[] = [];
  console.warn = mock((...args: unknown[]) => void said.push(args.join(" ")));
  try {
    run();
  } finally {
    console.warn = real;
  }
  return said;
}

const quietly = <T,>(run: () => T): T => {
  let out!: T;
  warnings(() => {
    out = run();
  });
  return out;
};

describe("withoutUnmeetableClears", () => {
  test("leaves a puzzle whose answer meets its requirement exactly as it was", () => {
    const [served] = quietly(() => withoutUnmeetableClears([HONEST]));

    expect(served!.requiredClears).toEqual(REQUIRED);
    expect(served).toBe(HONEST);
  });

  test("drops a requirement the puzzle's own answer cannot meet", () => {
    const [served] = quietly(() => withoutUnmeetableClears([DRIFTED]));

    expect(served!.requiredClears).toEqual([]);
  });

  test("keeps enforcing total attack on the puzzle it just disarmed", () => {
    const [served] = quietly(() => withoutUnmeetableClears([DRIFTED]));

    expect(served!.targetAttack).toBe(DRIFTED.targetAttack);
  });

  test("says so, naming the puzzle and what its answer was short of", () => {
    const said = warnings(() => withoutUnmeetableClears([DRIFTED]));

    expect(said).toHaveLength(1);
    expect(said[0]).toContain("42");
    expect(said[0]).toContain("tsd");
  });

  test("keeps a requirement it cannot judge, and says nothing about it", () => {
    let served: Puzzle | undefined;
    const said = warnings(() => {
      served = withoutUnmeetableClears([NO_ANSWER])[0];
    });

    expect(served!.requiredClears).toEqual(REQUIRED);
    expect(said).toEqual([]);
  });

  test("ignores a puzzle that never had a requirement", () => {
    const none = { ...DRIFTED, requiredClears: [] } as unknown as Puzzle;

    const said = warnings(() => withoutUnmeetableClears([none]));

    expect(said).toEqual([]);
  });

  test("does not mutate the puzzle it was given", () => {
    quietly(() => withoutUnmeetableClears([DRIFTED]));

    expect(DRIFTED.requiredClears).toEqual(REQUIRED);
  });
});
