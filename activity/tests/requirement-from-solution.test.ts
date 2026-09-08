/**
 * The clear requirement now comes from the answer, not from the sentence.
 *
 * The club's rule, decided after the engine and the puzzle makers were found to
 * disagree about naming: a maker titles and describes their puzzle however they
 * like, and what the server *enforces* is whatever their own solution actually
 * does when replayed. A goal reading "Clear 2 TSDs" whose answer makes a TSD and
 * a mini is enforced as a TSD and a mini, because that is the puzzle.
 *
 * This replaces a gate that read the prose and refused the requirement whenever
 * the answer disagreed. That gate was right that the two can disagree and wrong
 * about which one wins: it left 25 puzzles enforcing nothing rather than
 * enforcing what they demonstrably are.
 *
 * Counting is by engine name, so a `tsmini` is counted as a `tsmini` &mdash; see
 * `clearShortfall`, which this feeds and which makes the same distinction.
 */

import { describe, expect, test } from "bun:test";
import { requirementFromSolution } from "../shared/puzzle";
import type { ClearName } from "../shared/puzzle";

const clears = (...names: (ClearName | null)[]) => names.map((clear) => ({ clear }));

describe("requirementFromSolution", () => {
  test("counts each clear the answer makes, by engine name", () => {
    const got = requirementFromSolution(clears("tsd", "tsd", "tst"));

    expect(got).toEqual([
      { clear: "tsd", count: 2 },
      { clear: "tst", count: 1 },
    ]);
  });

  test("keeps a mini distinct from the full spin it resembles", () => {
    const got = requirementFromSolution(clears("tsd", "tsmini"));

    expect(got).toEqual([
      { clear: "tsd", count: 1 },
      { clear: "tsmini", count: 1 },
    ]);
  });

  test("ignores placements that clear nothing", () => {
    const got = requirementFromSolution(clears("tsd", null, null, "tsd"));

    expect(got).toEqual([{ clear: "tsd", count: 2 }]);
  });

  test("an answer that clears nothing requires nothing", () => {
    expect(requirementFromSolution(clears(null, null))).toEqual([]);
    expect(requirementFromSolution([])).toEqual([]);
  });

  test("orders by first appearance, so the same answer always reads the same", () => {
    const once = requirementFromSolution(clears("tst", "tsd", "tsd"));
    const twice = requirementFromSolution(clears("tst", "tsd", "tsd"));

    expect(once).toEqual(twice);
    expect(once.map((e) => e.clear)).toEqual(["tst", "tsd"]);
  });

  test("the answer it was built from always satisfies it", () => {
    const made: ClearName[] = ["tsd", "tsmini", "tst", "quad"];
    const { clearShortfall } = require("../shared/puzzle");

    expect(clearShortfall(made, requirementFromSolution(clears(...made)))).toEqual([]);
  });
});
