/**
 * A placement the author committed without locking the page.
 *
 * Puzzle #115 "twirl" is goaled "TST without moving left or right" and shipped
 * `requiredClears: [{tsd, 1}]` with `targetAttack: 4`. Its blueprint has eleven
 * pages and exactly one locked page, so reading only locked pages kept the T and
 * dropped the L that plugs the hole beneath it: the answer cleared two rows
 * instead of three. Because `requiredClears` is derived from the answer, the
 * puzzle then froze a rule its own goal contradicts — and under
 * `GOAL_ENFORCEMENT=on` the author's intended line is refused while lines that
 * ignore half the queue are accepted.
 *
 * The recovery reads a page that gains four settled cells and loses none as a
 * commit. **It is lossy in the other direction**, which is the other half of
 * this file: on a blueprint that clears rows, a locked page's cells reappear
 * shifted in a later playfield, get claimed as a commit, and suppress the locked
 * page they came from — it returns 68 placements for #112 where the locked pages
 * give 73, and is short by one on #24, #25, #127 and #133.
 *
 * So `buildPuzzle` takes it only when it is *longer* than the locked reading and
 * lands on the blueprint's own final board. The second describe block is what
 * keeps those five from regressing.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildPuzzle, decodeAnswerPlacements, decodeCommittedPlacements } from "../tools/decode-archive";
import { hasSolutions } from "./archive";

/*
 * `data/solutions.json` is untracked — an answer key beside the puzzles is an
 * answer key for everybody — so a fresh clone and every deploy box are without
 * it, and `activity/DEPLOY.md` makes `bun test` a deploy gate. Read behind the
 * same guard every other block needing the answers uses, rather than at module
 * scope where a missing file takes the whole file down.
 */
const solutions = (hasSolutions
  ? JSON.parse(readFileSync("data/solutions.json", "utf8")).solutions
  : []) as {
  id: number;
  title?: string;
  source: { puzzle: string; solution: string };
  solution: { piece: string }[];
}[];
const entry = (id: number) => solutions.find((s) => s.id === id)!;
/** The CSV row shape `buildPuzzle` reads: code at 1, answer at 2, title at 4. */
const row = (id: number) => ["", entry(id).source.puzzle, entry(id).source.solution, "", `p${id}`];

describe.skipIf(!hasSolutions)("an answer whose first piece was never locked", () => {
  test("reading only locked pages drops it", () => {
    expect(decodeAnswerPlacements(entry(115).source.solution)).toHaveLength(1);
  });

  test("reading playfield commits recovers it", () => {
    const recovered = decodeCommittedPlacements(entry(115).source.solution);

    expect(recovered).toHaveLength(2);
    expect(recovered[0]!.piece).toBe("L");
    expect(recovered[1]!.piece).toBe("T");
  });

  test("so #115 is built as the TST its goal asks for", () => {
    const built = buildPuzzle(115, row(115), undefined);

    expect(built.solution).toHaveLength(2);
    expect(built.targetAttack).toBe(6);
    expect(built.requiredClears).toEqual([{ clear: "tst", count: 1 }]);
  });
});

describe.skipIf(!hasSolutions)("the recovery does not fire where locked pages already agree", () => {
  test("#112's seventy-three placements survive", () => {
    // The puzzle the unguarded version destroyed, reduced to thirteen. Its
    // blueprint clears rows repeatedly, which is exactly the case where a
    // shifted echo looks like a fresh commit.
    const built = buildPuzzle(112, row(112), undefined);

    expect(built.solution!.length).toBe(entry(112).solution.length);
    expect(built.solution!.length).toBeGreaterThan(60);
  });

  test("and so do the other four the guard protects", () => {
    for (const id of [24, 25, 127, 133]) {
      expect(buildPuzzle(id, row(id), undefined).solution!.length).toBe(entry(id).solution.length);
    }
  });
});
