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

const APP = join(import.meta.dir, "..", "client", "src", "app.ts");
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

  test("every run-ending decision goes through the one that asks", () => {
    const source = readFileSync(RUNNER, "utf8");
    const exits = [...source.matchAll(/\bthis\.solved\(\)/g)];

    // Five today: `checkForEnd`, the ledger overrun, `input`'s log-full branch,
    // `placeAt`'s, and `commitPlacement`'s frame ceiling — the fourth arriving
    // with #37 and the fifth with #44, each converted where the branches met.
    // That is twice this count has moved for the same reason, which is the
    // reason it is a count.
    //
    // They used to call `solvesPuzzle` inline, five times over. They now call
    // one method, because the answer stopped being a pure function of the
    // running totals: a run that does not solve as played is re-scored on its
    // placements first, since the same squares can be worth two different
    // amounts depending on the kick that reached them. See `credit.ts`. An
    // exit left on the inline call would skip that and tell a player they
    // failed a puzzle they solved.
    //
    // Exact, not `>=`. This test exists so that adding an end point is a
    // deliberate act rather than a silent one, and a `>=` cannot fail on an
    // addition at all — it went stale the moment the fourth site landed and
    // would have tolerated a fifth, or the deletion of one, in silence.
    expect(
      exits.length,
      "The number of run-ending decisions in runner.ts changed. Each one must ask\n" +
        "`this.solved()` — which applies the full condition AND credits the placements\n" +
        "before answering. Update this count once the new site is converted.",
    ).toBe(5);
  });

  test("and the full condition is asked in exactly one place", () => {
    const source = readFileSync(RUNNER, "utf8");
    const full = [...source.matchAll(/\bsolvesPuzzle\s*\(/g)];

    // Both inside `solved()`: once to take a run that already solves at its
    // word, and once on the credited totals. A third would be an exit that had
    // gone back to deciding for itself.
    expect(
      full.length,
      "`solvesPuzzle` is called somewhere other than `solved()` in runner.ts.\n" +
        "A run-ending branch that asks it directly skips the placement credit and\n" +
        "will fail a player on a puzzle they solved. Route it through `this.solved()`.",
    ).toBe(2);
  });
});

describe("the solutions panel is never mounted empty", () => {
  test("nothing seeds it with an empty list", () => {
    // `show([])` clears the stepper and prints "No solutions on file" — correct
    // as an answer, wrong as an opening state. It was once used to initialise
    // the panel before the fetch, which left a solved player with no step
    // controls until the request landed, and none at all if it failed. The
    // seed is the maker's answer, which the run response already carried.
    const source = readFileSync(APP, "utf8");
    // The solutions panel specifically, by name: `show([])` is a perfectly good
    // call on a panel that means it, and this is about the one that does not.
    const seededEmpty = [
      ...source.matchAll(/walkthrough\.show\(\s*\[\s*\]/g),
      ...source.matchAll(/showGallery\([^,)]*,\s*\[\s*\]/g),
    ];

    expect(
      seededEmpty.map((m) => m[0]),
      "The solutions panel is being seeded with an empty list. Seed it with the\n" +
        "maker's answer (`App.makerLine`) instead — the run response already carries\n" +
        "it — or do not mount the panel until the gallery arrives.",
    ).toEqual([]);
  });
});
