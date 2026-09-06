/**
 * The one decision the alternates tool makes that could be wrong silently.
 *
 * Everything else it does is arithmetic over a `SearchReport` and printing. But
 * telling the author's own line apart from the rest is load-bearing in both
 * directions: mistake the reference for an alternate and every puzzle in the
 * archive is reported as broken; mistake an alternate for the reference and a
 * real finding disappears.
 *
 * It compares canonical keys rather than object identity, which is what lets a
 * line the search *rediscovered* — the same seats reached by its own route —
 * count as the reference rather than as a new solution.
 */

import { describe, expect, test } from "bun:test";
import { judge, verdictOf } from "../tools/find-alternates";
import type { Puzzle, SolutionStep } from "../shared/puzzle";
import type { SearchReport } from "../shared/tetris/enumerate";

const REFERENCE: SolutionStep[] = [
  { piece: "T", cells: [[3, 0], [4, 0], [5, 0], [4, 1]], clear: "tsd", attack: 4 },
];
/** The same seats, written in another order — the search's output, not the archive's. */
const REDISCOVERED: SolutionStep[] = [
  { piece: "T", cells: [[4, 1], [5, 0], [3, 0], [4, 0]], clear: "tsd", attack: 4 },
];
const ELSEWHERE: SolutionStep[] = [
  { piece: "T", cells: [[5, 0], [6, 0], [7, 0], [6, 1]], clear: "tsd", attack: 4 },
];

const puzzleWith = (solution?: SolutionStep[]): Puzzle =>
  ({ id: 15, goal: "Clear 1 TSD", targetAttack: 4, solution } as unknown as Puzzle);

const reportOf = (...lines: SolutionStep[][]): SearchReport => ({
  lines: lines.map((placements) => ({ placements, attack: 4, clears: ["tsd"] as const })),
  stoppedBy: "exhausted",
  nodes: 1,
  millis: 1,
}) as unknown as SearchReport;

describe("telling the author's line from the rest", () => {
  test("the reference is not an alternate, however the search wrote it down", () => {
    const verdict = judge(puzzleWith(REFERENCE), reportOf(REDISCOVERED));

    expect(verdict.alternates).toHaveLength(0);
    expect(verdict.refFound).toBe(true);
  });

  test("a line in different seats is an alternate", () => {
    const verdict = judge(puzzleWith(REFERENCE), reportOf(REDISCOVERED, ELSEWHERE));

    expect(verdict.alternates).toHaveLength(1);
    expect(verdict.refFound).toBe(true);
  });

  test("a search that never found the author's line says so", () => {
    // The tool's loudest output. It means the search is budget-limited or
    // wrong, and every other number in the report depends on which.
    const verdict = judge(puzzleWith(REFERENCE), reportOf(ELSEWHERE));

    expect(verdict.alternates).toHaveLength(1);
    expect(verdict.refFound).toBe(false);
  });

  test("with no answer on file, every line is an alternate and nothing is claimed", () => {
    // `data/solutions.json` is untracked, so this is an ordinary checkout. The
    // tool must not report "did not re-find the answer" when there is no answer.
    const verdict = judge(puzzleWith(undefined), reportOf(REFERENCE, ELSEWHERE));

    expect(verdict.alternates).toHaveLength(2);
    expect(verdict.refFound).toBeNull();
  });

  test("a search that exhausted and found nothing is not 'only the intended line'", () => {
    // The worst thing this tool can say. A goal naming a clear the board cannot
    // make exhausts with zero lines — and with no answer key on file (the
    // ordinary checkout, since data/solutions.json is untracked) `refFound` is
    // null, so the loud warning never fires either. Counted as "tight" it hands
    // a maker a clean bill of health for a puzzle nobody can finish.
    const verdict = judge(puzzleWith(REFERENCE), {
      lines: [],
      stoppedBy: "exhausted",
      nodes: 999,
      millis: 12,
    } as unknown as SearchReport);

    expect(verdictOf(verdict)).toBe("unsolvable");
  });

  test("and with no answer on file it is still not tight", () => {
    const verdict = judge(puzzleWith(undefined), {
      lines: [],
      stoppedBy: "exhausted",
      nodes: 999,
      millis: 12,
    } as unknown as SearchReport);

    expect(verdictOf(verdict)).toBe("unsolvable");
  });

  test("the three honest verdicts are told apart", () => {
    const exhausted = (lines: SolutionStep[][]) =>
      ({ lines: lines.map((placements) => ({ placements, attack: 4, clears: ["tsd"] as const })),
         stoppedBy: "exhausted", nodes: 1, millis: 1 }) as unknown as SearchReport;

    expect(verdictOf(judge(puzzleWith(REFERENCE), exhausted([REDISCOVERED])))).toBe("tight");
    expect(verdictOf(judge(puzzleWith(REFERENCE), exhausted([REDISCOVERED, ELSEWHERE])))).toBe("loose");
    expect(
      verdictOf(judge(puzzleWith(REFERENCE), reportOf(REDISCOVERED))) === "tight",
    ).toBe(true);
    // Budget-limited is never a proof of anything.
    const partial = { lines: [], stoppedBy: "time", nodes: 5, millis: 20 } as unknown as SearchReport;
    expect(verdictOf(judge(puzzleWith(REFERENCE), partial))).toBe("incomplete");
  });
});
