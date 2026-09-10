/**
 * A placement is worth what the squares are worth, not what the route earned.
 *
 * The bug this pins: on a polymer setup a T ends with fewer than two front
 * corners, which scores a **mini** unless the piece arrived on the fin/TST
 * kick. The final four squares are identical either way. The archive's own
 * `targetAttack` and `requiredClears` are derived through
 * `RoutePlanner.placementAt`, which keeps the best-scoring route — so the
 * puzzle demanded a score only some routes produce while the player was judged
 * on the route they took.
 *
 * Four archive puzzles were solvable only by a player who guessed the right
 * kick, and the reveal could not teach it. Worse, dragging commits through
 * `placementAt` and silently takes the best kick, so the bug punished the
 * keyboard specifically.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { archive, hasSolutions, solutionOf } from "./archive";
import { clearsOf, creditPlacements, mayBeUnderCredited, total } from "../shared/tetris/credit";
import { DEFAULT_HANDLING } from "../shared/tetris/handling";
import { decodeBoard, ENGINE_ROWS, solvesPuzzle, type Puzzle } from "../shared/puzzle";

/** The four the scan found, with what a losing kick actually scores. */
const POLYMER = [
  { id: 3, worst: ["tsd", "double", "tst"] },
  { id: 6, worst: ["tsmini", "tsd"] },
  { id: 17, worst: ["tsmini", "tsd"] },
  { id: 92, worst: ["tsmini", "tsd", "tst"] },
] as const;

const setupOf = (puzzle: Puzzle) => ({
  board: decodeBoard(puzzle.board, ENGINE_ROWS),
  queue: puzzle.queue,
  hold: puzzle.hold,
});

/**
 * The reference answer, re-scored as the losing kick would have scored it.
 *
 * Same squares — that is the whole point — with the clears a worse route
 * produces substituted in, which is exactly the run a keyboard player files.
 */
function asPlayedBadly(puzzle: Puzzle, worst: readonly string[]) {
  const played = solutionOf(puzzle).map((step) => ({
    piece: step.piece,
    cells: step.cells,
    clear: step.clear,
    attack: step.attack,
  }));
  let index = 0;
  for (const placement of played) {
    if (placement.clear === null) continue;
    const wanted = worst[index++];
    if (wanted !== placement.clear) {
      placement.clear = wanted as never;
      // A lost spin is worth its plain line clear. The exact number does not
      // matter to the assertions — only that it falls short.
      placement.attack = 1;
    }
  }
  return played;
}

describe("when re-scoring is even attempted", () => {
  test("a run with no T at all is left alone, and costs nothing", () => {
    // The guard is the whole performance story: replaying every placement
    // costs milliseconds, and nearly every run has nothing to recover.
    expect(
      mayBeUnderCredited([{ piece: "I", cells: [], clear: "quad", attack: 4 }]),
    ).toBe(false);
  });

  test("a T that was credited its T-spin is left alone", () => {
    expect(mayBeUnderCredited([{ piece: "T", cells: [], clear: "tsd", attack: 4 }])).toBe(false);
  });

  test("a T that cleared lines with no T-spin credited is re-scored", () => {
    // Both halves of the bug: the mini (#6, #17, #92)...
    expect(mayBeUnderCredited([{ piece: "T", cells: [], clear: "tsmini", attack: 1 }])).toBe(true);
    // ...and the one credited no spin at all, which is #3's worst route.
    expect(mayBeUnderCredited([{ piece: "T", cells: [], clear: "double", attack: 1 }])).toBe(true);
  });

  test("a T that cleared nothing is left alone", () => {
    expect(mayBeUnderCredited([{ piece: "T", cells: [], clear: null, attack: 0 }])).toBe(false);
  });
});

describe.if(hasSolutions)("the four puzzles a kick could lock a player out of", () => {
  for (const { id, worst } of POLYMER) {
    const puzzle = archive.find((entry) => entry.id === id);

    test(`#${id} is unsolvable on the losing kick, and solvable once credited`, () => {
      expect(puzzle).toBeDefined();
      const played = asPlayedBadly(puzzle!, worst);

      // What the player earns today: short of the target, and missing a clear
      // the goal names.
      expect(solvesPuzzle(total(played), clearsOf(played), puzzle!)).toBe(false);

      const credited = creditPlacements(setupOf(puzzle!), DEFAULT_HANDLING, played);
      expect(credited).not.toBeNull();
      expect(total(credited!)).toBe(puzzle!.targetAttack);
      expect(solvesPuzzle(total(credited!), clearsOf(credited!), puzzle!)).toBe(true);
    });
  }
});

describe.if(hasSolutions)("what re-scoring must never do", () => {
  test("it cannot lower a score", () => {
    // `placementAt` selects the highest-attack route, so a lower total means
    // the replay disagreed with the run about what happened — and a scoring
    // rule that takes points off a finished run is not one worth having.
    //
    // Every placement here is real and replayable, so the null can only come
    // from the guard: the run claims more than the best route can produce.
    const puzzle = archive.find((entry) => entry.id === 92)!;
    const played = asPlayedBadly(puzzle, POLYMER.find((p) => p.id === 92)!.worst);
    const inflated = played.map((step, index) =>
      index === 0 ? { ...step, attack: step.attack + 999 } : step,
    );

    // The replay itself succeeds and comes back lower — this is the case the
    // guard exists for, not an unreplayable run.
    expect(creditPlacements(setupOf(puzzle), DEFAULT_HANDLING, played)).not.toBeNull();
    expect(total(inflated)).toBeGreaterThan(puzzle.targetAttack);
    expect(creditPlacements(setupOf(puzzle), DEFAULT_HANDLING, inflated)).toBeNull();
  });

  test("a run whose placements will not replay stands as played", () => {
    const puzzle = archive.find((entry) => entry.id === 92)!;
    expect(
      creditPlacements(setupOf(puzzle), DEFAULT_HANDLING, [
        // Squares no piece can reach on this board.
        { piece: "T", cells: [[0, 0], [1, 0], [2, 0], [1, 1]], clear: "double", attack: 1 },
      ]),
    ).toBeNull();
  });
});

describe.if(hasSolutions)("every other puzzle is untouched", () => {
  test("no reference answer's score moves when it is re-scored", () => {
    // The reference answers are already derived at the best route, so crediting
    // them must be a no-op everywhere. If this ever moves, the credit rule has
    // started disagreeing with the pipeline that sets the targets.
    const moved: number[] = [];
    for (const puzzle of archive) {
      const played = solutionOf(puzzle).map((step) => ({
        piece: step.piece,
        cells: step.cells,
        clear: step.clear,
        attack: step.attack,
      }));
      const credited = creditPlacements(setupOf(puzzle), DEFAULT_HANDLING, played);
      if (credited && total(credited) !== total(played)) moved.push(puzzle.id);
    }
    expect(moved).toEqual([]);
  });
});

/**
 * The rule being right is worth nothing if nobody calls it.
 *
 * This was measured, not supposed: replacing the `creditPlacements(...)` call
 * in `verify.ts` with `null` left the whole suite green at 1039 pass / 1 fail.
 * Every test above exercises the function in isolation, so the fix could be
 * deleted from the scoring authority and nothing would say so.
 *
 * A source check rather than a behavioural one, and the limitation is worth
 * stating plainly: proving it behaviourally needs an input log that takes the
 * *losing* kick, which means generating ticks for a deliberately worse route
 * and feeding them to `verifyRun`. That is worth building and is not built.
 * Until it is, this at least makes deleting either call site a loud act rather
 * than a silent one — the same job `run-end-condition.test.ts` does next door.
 */
describe("both scoring authorities actually credit", () => {
  const read = (...parts: string[]) => readFileSync(join(import.meta.dir, "..", ...parts), "utf8");

  test("the server verifier credits the placements it derived", () => {
    // Without this, a run is filed at whatever the player's route happened to
    // earn — which is the entire bug, on the side that decides what a run was
    // worth.
    expect(
      /creditPlacements\s*\(/.test(read("shared", "tetris", "verify.ts")),
      "verify.ts no longer calls creditPlacements. The server would file runs at\n" +
        "the route's score rather than the placement's, and puzzles #3, #6, #17 and\n" +
        "#92 become unsolvable again for anyone who takes the losing kick.",
    ).toBe(true);
  });

  test("the client runner credits before it decides a run failed", () => {
    // Without this the client never submits the run at all, so the server's
    // crediting never gets the chance to matter.
    expect(
      /creditPlacements\s*\(/.test(read("client", "src", "game", "runner.ts")),
      "runner.ts no longer calls creditPlacements. A run the client calls failed is\n" +
        "never submitted, so this half cannot be left to the server.",
    ).toBe(true);
  });
});
