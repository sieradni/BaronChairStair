/**
 * The graded band keeps the bottom rows reachable by touch.
 *
 * A review of the flat band (PR #68) proved a touch could name only rows 3
 * and up — and that a lifted row-3 aim is refused outright on an empty board,
 * because `targetAt` answers pre-gravity and `placementAt` accepts only exact
 * locks. These run the real planner the way that review did and pin the
 * contract: the band's thirds land on rows 2, 1 and 0, and every aim they can
 * produce places every piece where a mouse's aim places.
 */

import { describe, expect, test } from "bun:test";
import { createPuzzleEngine } from "../shared/tetris/engine";
import { RoutePlanner } from "../shared/tetris/pathfinder";
import { DEFAULT_HANDLING } from "../shared/tetris/handling";
import { decodeBoard, ENGINE_ROWS, type Mino } from "../shared/puzzle";
import { bandRow, liftSpot, TOUCH_LIFT_ROWS } from "../client/src/game/pointer";

const PIECES = ["I", "O", "T", "S", "Z", "J", "L"] as const;

/** An empty board and the piece under test as the falling one. */
function freshPlanner(piece: string): RoutePlanner {
  const { engine } = createPuzzleEngine(
    {
      board: decodeBoard([], ENGINE_ROWS),
      queue: [piece, piece, piece] as Mino[],
      hold: null,
    },
    DEFAULT_HANDLING,
  );
  return new RoutePlanner(engine);
}

describe("touch reaches the bottom rows", () => {
  test("the band's thirds, lifted, name exactly rows 2, 1 and 0", () => {
    const lifted = [5, 15, 25].map(
      (depth) => liftSpot({ column: 4, row: bandRow(depth, 30)! }, TOUCH_LIFT_ROWS, ENGINE_ROWS).row,
    );
    expect(lifted).toEqual([2, 1, 0]);
  });

  test("each band third places on the seat it names, for every piece", () => {
    // The bottom row needs the floor beneath it, the second a row below it —
    // seats one row apart cannot all be free on one board, so each board here
    // proves the band third that lands on its lowest free row. The
    // empty-board case is the review's blocking probe: the flat band lifted
    // everything to row 3, and a lifted row-3 aim was refused for every
    // piece.
    const cases: { rows: string[]; seat: number }[] = [
      { rows: [], seat: 0 },
      { rows: ["GGGGGGGGGG"], seat: 1 },
      { rows: ["GGGGGGGGGG", "GGGGGGGGGG"], seat: 2 },
    ];
    for (const piece of PIECES) {
      for (const { rows, seat } of cases) {
        const { engine } = createPuzzleEngine(
          {
            board: decodeBoard(rows, ENGINE_ROWS),
            queue: [piece, piece, piece] as Mino[],
            hold: null,
          },
          DEFAULT_HANDLING,
        );
        const planner = new RoutePlanner(engine);
        expect(planner.placementAt(planner.targetAt(4, seat))).not.toBeNull();
      }
    }
  });

  test("the lifted floor aim places where an unlifted row-3 aim refuses", () => {
    // The discriminating pair: the defect was a band that produced raw 0,
    // lifting to row 3 — placeless. The floor's raw row is −3, lifting to 0.
    const planner = freshPlanner("O");
    const floor = liftSpot({ column: 4, row: bandRow(29, 30)! }, TOUCH_LIFT_ROWS, ENGINE_ROWS);
    expect(floor.row).toBe(0);
    expect(planner.placementAt(planner.targetAt(4, floor.row))).not.toBeNull();
    expect(planner.placementAt(planner.targetAt(4, 3))).toBeNull();
  });
});
