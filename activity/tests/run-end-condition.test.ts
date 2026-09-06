/**
 * Every run-ending decision goes through `solvesPuzzle`, not `meetsTarget`.
 *
 * `meetsTarget` answers "is the attack target reached", which used to be the
 * whole solve condition and is now half of it. A run that ends on that half
 * ends before a required clear can be made — which does not score a puzzle
 * wrongly, it makes it **unsolvable**, and the player is simply stopped with
 * pieces left and the goal unmet.
 *
 * `client/src/game/runner.ts` is where that decision lives, in three places
 * today. The risk is not that those three regress; it is that a *fourth* is
 * added. That is not hypothetical — PR #37 (touch placement) adds a `placeAt()`
 * whose log-full branch ends the run, and merging the two produces a tree that
 * git resolves without conflict and `tsc` then rejects. This test is what makes
 * that collision loud in the right place, and names the fix.
 *
 * A source check rather than a behavioural one, deliberately. The failure mode
 * is a call site that does not exist yet, in a method nobody has written, and no
 * fixture can exercise code that is not there.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const RUNNER = join(import.meta.dir, "..", "client", "src", "game", "runner.ts");

describe("the run's end condition", () => {
  test("no run-ending decision in the runner is made on attack alone", () => {
    const source = readFileSync(RUNNER, "utf8");
    // Comments may name it — this file's own docblocks do. Only a call counts.
    const calls = [...source.matchAll(/^(?!\s*(?:\/\/|\*|\/\*)).*\bmeetsTarget\s*\(/gm)];

    expect(
      calls.map((m) => m[0].trim()),
      "A run-ending decision is being made on the attack target alone. Use\n" +
        "`solvesPuzzle(this.attack, this.clears, this.puzzle)` instead — the run\n" +
        "must continue past the attack target while a required clear is still\n" +
        "outstanding, or the puzzle cannot be solved at all.",
    ).toEqual([]);
  });

  test("and every one that exists uses the full condition", () => {
    const source = readFileSync(RUNNER, "utf8");
    const full = [...source.matchAll(/\bsolvesPuzzle\s*\(/g)];

    // Five today: `checkForEnd`, the ledger overrun, `input`'s log-full branch,
    // `placeAt`'s, and `commitPlacement`'s frame ceiling — the fourth arriving
    // with #37 and the fifth with #44, each converted where the branches met.
    // That is twice this count has moved for the same reason, which is the
    // reason it is a count.
    //
    // Exact, not `>=`. This test exists so that adding an end point is a
    // deliberate act rather than a silent one, and a `>=` cannot fail on an
    // addition at all — it went stale the moment the fourth site landed and
    // would have tolerated a fifth, or the deletion of one, in silence. If this
    // fails, count the run-ending branches in `runner.ts`: if the new number is
    // right, say so here; if it is not, the new branch needs the full
    // condition.
    expect(
      full.length,
      "The number of run-ending decisions in runner.ts changed. Each one must ask\n" +
        "`solvesPuzzle(this.attack, this.clears, this.puzzle)` — a run has to continue\n" +
        "past the attack target while a required clear is outstanding, or the puzzle\n" +
        "cannot be solved at all. Update this count once the new site is converted.",
    ).toBe(5);
  });
});
