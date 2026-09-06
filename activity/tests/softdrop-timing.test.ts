/**
 * A seat the drag offers at the default soft drop must still be offered —
 * and land — when the player has turned the slider down.
 *
 * The bug this pins: the BFS models a mid-route soft drop as "descend to
 * rest", but `ticksForRoute` held the key across exactly one tick boundary,
 * which descends `0.05 × sdf` rows. That equals the model only at `sdf 41`,
 * so below it every kick after the soft drop fired from a height the route
 * was never walked from, the trial failed to land on target, and
 * `placementAt` refused the route — the drag silently lost the kick and tuck
 * seats it advertised. (Measured on the archive before the fix: 37 of 439
 * soft-drop seats across 40 puzzles refused at sdf 5 alone.)
 *
 * The fix: a soft drop is held for `ceil(rows / (0.05 × sdf))` frames — the
 * descent the route planned, delivered at the rate the handling descends,
 * with surplus ticks inert because a fall clamps at rest and nothing locks
 * while a key is held. At `sdf 41` the engine's instant drop covers any
 * distance in one tick, so the computation returns 1 and every
 * default-handling log is byte-for-byte what it always was — pinned below.
 *
 * Both fixtures are real archive puzzles: puzzle 3's Z tuck (one soft drop,
 * 14 rows, then two kicks) and puzzle 12's L (two soft drops, 13 rows and 1).
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { RoutePlanner, softDropTicks, ticksForRoute, type TargetCells } from "../shared/tetris/pathfinder";
import { createPuzzleEngine } from "../shared/tetris/engine";
import { DEFAULT_HANDLING, type Handling } from "../shared/tetris/handling";
import { verifyRun, type InputEvent } from "../shared/tetris/verify";
import { decodeBoard, ENGINE_ROWS } from "../shared/puzzle";
import { PuzzleRun } from "../client/src/game/runner";
import { pump, pumpUntil, resetHarness, SAFE_LOCK_FRAMES } from "./harness";

/** Puzzle 3 from the archive: the Z must finish a 14-row descent before two kicks tuck it in. */
const TUCK_BOARD = [
  "GGGG.GGGGG",
  "GGGG..GGGG",
  "GGGG..GGGG",
  "G.G...GGGG",
  "G......GGG",
  "G.......GG",
  ".........G",
  "G........G",
];
const TUCK_CELLS: TargetCells = [
  [0, 6],
  [1, 6],
  [1, 5],
  [2, 5],
];

/** Puzzle 12 from the archive: the L's chosen route soft drops twice (13 rows, then 1). */
const TWICE_BOARD = [
  "GGGGG.GGGG",
  "GGGG..GGGG",
  "GGGGG.GGGG",
  "G.GG..GGGG",
  "...GG.GGGG",
  "......GGGG",
  "......GGGG",
  "GG....GGGG",
  "G.....GGGG",
  "G.....GGGG",
  ".....GGGGG",
];
const TWICE_CELLS: TargetCells = [
  [2, 5],
  [0, 4],
  [1, 4],
  [2, 4],
];

function handlingWith(sdf: number): Handling {
  return { ...DEFAULT_HANDLING, sdf };
}

/** Seats compare as sets: verify reports blocks in the engine's own order. */
function cellsOf(cells: readonly (readonly [number, number])[]): string[] {
  return cells.map(([x, y]) => `${x},${y}`).sort();
}

beforeEach(() => {
  resetHarness();
});

describe("softDropTicks arithmetic", () => {
  test("the hold covers the descent at the handling's own rate", () => {
    // The engine descends 0.05 × sdf rows per held tick (measured by probe).
    // sdf 5 descends a quarter row a tick, so a 14-row descent needs 56.
    expect(softDropTicks(5, 14)).toBe(56);
    expect(softDropTicks(10, 14)).toBe(28);
    expect(softDropTicks(20, 14)).toBe(14);
    // A 1-row descent: sdf 5 rounds up to 4 ticks, not 3.
    expect(softDropTicks(5, 1)).toBe(4);
  });

  test("the count never falls below one tick and is instant at the default", () => {
    expect(softDropTicks(41, 14)).toBe(1);
    expect(softDropTicks(41, 400)).toBe(1);
    expect(softDropTicks(5, 0.5)).toBe(2);
    expect(softDropTicks(5, 0.1)).toBe(1);
  });

  test("a missing distance falls back to the old one-tick hold", () => {
    expect(softDropTicks(5, 0)).toBe(1);
  });
});

describe("a mid-route soft drop descends as far as the route walked it", () => {
  test("the advertised tuck seat places at sdf 5, not just at the default", () => {
    const { engine } = createPuzzleEngine(
      { board: decodeBoard(TUCK_BOARD, ENGINE_ROWS), queue: ["Z"], hold: null },
      handlingWith(5),
    );
    const planner = new RoutePlanner(engine);
    const placement = planner.placementAt(TUCK_CELLS);
    expect(placement).not.toBeNull();
    expect(placement!.route).toContain("softDrop");
    expect(placement!.softDrops).toEqual([14]);
  });

  test("the descent the route plans is held for the ticks sdf 5 needs", () => {
    const { engine } = createPuzzleEngine(
      { board: decodeBoard(TUCK_BOARD, ENGINE_ROWS), queue: ["Z"], hold: null },
      handlingWith(5),
    );
    const placement = new RoutePlanner(engine).placementAt(TUCK_CELLS)!;
    // The distances the planner measured are the very thing the timing needs;
    // without them the call degrades to the honest one-tick minimum.
    const batches = ticksForRoute(placement.route, engine.frame, 5, placement.softDrops);
    // 14 rows at 0.25 rows a tick is ceil(14 / 0.25) = 56 held frames: the
    // soft drop's down opens its own batch, 55 eventless batches follow, and
    // the boundary under the up closes the 56th.
    const downs = batches.flatMap((batch, index) =>
      batch
        .filter((event) => event.type === "keydown" && event.data.key === "softDrop")
        .map(() => index),
    );
    expect(downs.length).toBe(1);
    const heldFrames = batches.length - 1 - downs[0]!;
    expect(heldFrames).toBe(56);
  });

  test("the committed lock lands on the advertised cells and the server agrees at sdf 5", () => {
    const run = new PuzzleRun(
      {
        id: 3, title: "tuck", author: "archive", difficulty: 1,
        goal: "parity", set: null, board: TUCK_BOARD,
        queue: ["Z", "O", "O", "O", "O", "O"] as const,
        hold: null, targetAttack: 999,
      },
      handlingWith(5),
      { onFrame: () => {}, onFinish: () => {}, onLock: () => {} },
    );
    run.aimAt({ column: TUCK_CELLS[0]![0], row: TUCK_CELLS[0]![1] });
    const aim = run.view().aim;
    expect(aim).not.toBeNull();
    expect(aim!.legal).toBe(true);
    expect(run.placeAt()).toBe(true);
    pumpUntil(() => run.snapshot().piecesPlaced === 1);
    pump(SAFE_LOCK_FRAMES);

    // Every advertised square is filled and nothing else changed: the piece
    // is exactly where the hollow showed.
    const filled = new Set<string>();
    for (const [x, y] of TUCK_CELLS) {
      filled.add(`${x},${y}`);
    }
    const board = run.view().cells;
    for (let y = 0; y < board.length; y++) {
      for (let x = 0; x < (board[y]?.length ?? 0); x++) {
        if (board[y]![x] !== null) filled.delete(`${x},${y}`);
      }
    }
    expect([...filled]).toEqual([]);

    const verified = verifyRun(
      { board: decodeBoard(TUCK_BOARD, ENGINE_ROWS), queue: ["Z", "O", "O", "O", "O", "O"] as const, hold: null },
      handlingWith(5),
      structuredClone(run.log()) as InputEvent[],
    );
    expect(verified.placements.length).toBe(1);
    expect(cellsOf(verified.placements[0]!.cells)).toEqual(cellsOf(TUCK_CELLS));
    run.dispose();
  });

  test("a route with two soft drops gets its full descent each time at sdf 5", () => {
    const setup = {
      board: decodeBoard(TWICE_BOARD, ENGINE_ROWS),
      queue: ["L", "O", "O", "O", "O", "O"] as const,
      hold: null,
    };
    const { engine } = createPuzzleEngine(setup, handlingWith(5));
    const planner = new RoutePlanner(engine);
    const placement = planner.placementAt(TWICE_CELLS);
    expect(placement).not.toBeNull();
    expect(placement!.softDrops.length).toBe(2);
    expect(placement!.softDrops).toEqual([13, 1]);

    // The log the commit would record: the first drop holds ceil(13/0.25) = 52
    // frames, the second ceil(1/0.25) = 4 — each as its own run of eventless
    // batches between a down and an up.
    const batches = ticksForRoute(placement!.route, 0, 5, placement!.softDrops);
    const emptyRuns: number[] = [];
    let run = 0;
    for (const batch of batches) {
      if (batch.length === 0) {
        run++;
      } else {
        if (run > 0) emptyRuns.push(run);
        run = 0;
      }
    }
    if (run > 0) emptyRuns.push(run);
    // 13 rows at a quarter row a tick is 52 frames, the first closed by the
    // down's own tick — 51 eventless — and 1 row is 4 frames, 3 eventless.
    expect(emptyRuns).toEqual([51, 3]);

    // And the replay lands the piece on the advertised seat.
    const verified = verifyRun(setup, handlingWith(5), structuredClone(run0(placement!)) as InputEvent[]);
    expect(verified.placements.length).toBe(1);
    expect(cellsOf(verified.placements[0]!.cells)).toEqual(cellsOf(TWICE_CELLS));

    /** The placement's route as a flat log, as the runner would record it. */
    function run0(p: NonNullable<typeof placement>): InputEvent[] {
      const log: InputEvent[] = [];
      let frame = 0;
      let drop = 0;
      const ticks = ticksForRoute(p.route, 0, 5, p.softDrops);
      for (const batch of ticks) {
        for (const event of batch) log.push({ ...event, frame });
        frame++;
      }
      void drop;
      return log;
    }
  });

  test("at the default sdf 41 every soft drop is still exactly one held tick", () => {
    const { engine } = createPuzzleEngine(
      { board: decodeBoard(TUCK_BOARD, ENGINE_ROWS), queue: ["Z"], hold: null },
      handlingWith(DEFAULT_HANDLING.sdf),
    );
    const placement = new RoutePlanner(engine).placementAt(TUCK_CELLS)!;
    const batches = ticksForRoute(placement.route, engine.frame, DEFAULT_HANDLING.sdf, placement.softDrops);
    // The old shape, preserved: one batch opens with the soft drop's keydown,
    // the next opens with its keyup — one boundary, as every default log has.
    const openers = batches.map((batch) => batch[0]!.data.key);
    expect(openers).toContain("softDrop");
    const softDropIndex = openers.indexOf("softDrop");
    expect(batches[softDropIndex]!.length).toBe(1);
    expect(batches[softDropIndex]![0]!.type).toBe("keydown");
    expect(batches[softDropIndex! + 1]![0]!.data.key).toBe("softDrop");
    expect(batches[softDropIndex! + 1]![0]!.type).toBe("keyup");
    expect(batches.some((batch) => batch.length === 0)).toBe(false);
  });
});
