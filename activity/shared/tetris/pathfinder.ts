/**
 * Finds a sequence of inputs that puts the falling piece on a target square.
 *
 * The archive stores solutions as final resting positions, but a spin only
 * counts if the *last* input before the drop was a rotation — so replaying a
 * solution means reconstructing plausible inputs, not teleporting the piece.
 * Paths found here are always replayed through the real engine afterwards, so
 * a wrong guess shows up as a mismatch rather than a silently bogus score.
 *
 * The same machinery answers a different question at run time: a player drags
 * a piece to a square and lets go. The drag is honest only if it becomes the
 * keys a player could have pressed, so the route found here is what the run
 * records — which is why route selection lives in exactly one definition
 * ({@link RoutePlanner.placementAt}), shared by the build pipeline and the
 * browser.
 */

import { Engine, Tetromino } from "@haelp/teto/engine";
import type { LockRes, Rotation } from "@haelp/teto/engine";

export type MoveKey =
  | "moveLeft"
  | "moveRight"
  | "rotateCW"
  | "rotateCCW"
  | "rotate180"
  | "softDrop";

const ROTATION_MOVES = ["rotateCW", "rotateCCW", "rotate180"] as const;
const ALL_MOVES: readonly MoveKey[] = ["moveLeft", "moveRight", ...ROTATION_MOVES, "softDrop"];

/**
 * Enough distinct rotation entries to find the strongest kick without replaying
 * every route on the board.
 */
const MAX_ROTATION_CANDIDATES = 12;

/** How many quarter-turns clockwise each rotation key applies. */
const ROTATION_AMOUNT: Readonly<Record<(typeof ROTATION_MOVES)[number], number>> = {
  rotateCW: 1,
  rotate180: 2,
  rotateCCW: 3,
};

/** Board squares the piece must end up occupying, in any order. */
export type TargetCells = readonly (readonly [number, number])[];

interface PieceState {
  readonly location: readonly [number, number];
  readonly rotation: number;
}

interface ReachableState {
  readonly state: PieceState;
  readonly path: MoveKey[];
}

/**
 * One honest way to put the piece down: the input log that puts it there,
 * proven by a trial lock on the real engine.
 */
export interface Placement {
  readonly route: MoveKey[];
}

/**
 * Keys a committed route can name: the search moves, the drop that ends the
 * route, and — for releases only — the hold key a player can have down.
 */
export type RouteKey = MoveKey | "hardDrop" | "hold";

/**
 * One engine input, shaped like the log the run keeps: trials, commits and
 * the server replay all speak these, so a placement promised anywhere is one
 * the log can keep everywhere.
 */
export interface RouteTick {
  readonly type: "keydown" | "keyup";
  readonly frame: number;
  readonly data: { readonly key: RouteKey; readonly subframe: number };
}

/** Release order, fixed so trials and commits release held keys identically. */
const RELEASE_ORDER: readonly RouteKey[] = [
  "moveLeft",
  "moveRight",
  "softDrop",
  "rotateCCW",
  "rotateCW",
  "rotate180",
  "hold",
];

/**
 * Keyups for whatever the engine currently holds, in canonical order: every
 * route assumes its keys land, and a key the player still holds would swallow
 * the route's own press of it. Both the trial and the commit open with these,
 * which is what keeps a drag aimed while holding a direction honest.
 */
export function releaseTicks(engine: Engine, frame: number): RouteTick[] {
  const up = (key: RouteKey): RouteTick => ({ type: "keyup", frame, data: { key, subframe: 0 } });
  const batch: RouteTick[] = [];
  if (engine.input.lShift.held) batch.push(up("moveLeft"));
  if (engine.input.rShift.held) batch.push(up("moveRight"));
  const keys = engine.input.keys as Record<string, boolean>;
  for (const key of RELEASE_ORDER) {
    if (key === "moveLeft" || key === "moveRight") continue;
    if (keys[key]) batch.push(up(key));
  }
  return batch;
}

/**
 * `route` as timed tick batches — the one shape trial, commit and server all
 * play. Every key goes down and up; edge keys (moves, rotations, hard drop)
 * share one tick, which keeps them handling-independent, while a soft drop's
 * down ends its tick so the drop is genuinely held across the boundary and
 * descends for real. Subframes are zero throughout: with every pair closed
 * inside its tick no slice phase ever sees a held key, so the value is inert
 * and trials cannot drift from commits.
 */
export function ticksForRoute(route: readonly MoveKey[], firstFrame: number): RouteTick[][] {
  const ticks: RouteTick[][] = [];
  let frame = firstFrame;
  let open: RouteTick[] = [];
  const flush = (): void => {
    if (open.length > 0) {
      ticks.push(open);
      open = [];
      frame++;
    }
  };
  const down = (key: RouteKey): RouteTick => ({ type: "keydown", frame, data: { key, subframe: 0 } });
  const up = (key: RouteKey): RouteTick => ({ type: "keyup", frame, data: { key, subframe: 0 } });
  for (const key of [...route, "hardDrop" as const]) {
    if (key === "softDrop") {
      flush();
      open.push(down(key));
      flush();
      open.push(up(key));
    } else {
      open.push(down(key), up(key));
    }
  }
  flush();
  return ticks;
}

function stateOf(piece: Tetromino): PieceState {
  return { location: [piece.location[0]!, piece.location[1]!], rotation: piece.rotation };
}

function keyOf(state: PieceState): string {
  return `${state.location[0]},${Math.floor(state.location[1])},${state.rotation}`;
}

/**
 * Placements are matched on occupied squares rather than on (x, y, rotation):
 * the archive's piece origins and rotation states are its own, and only the
 * squares are unambiguous across both coordinate systems.
 */
function cellsKey(cells: TargetCells): string {
  return cells
    .map(([x, y]) => `${x}:${y}`)
    .sort()
    .join("|");
}

/**
 * A scratch piece sharing the real piece's shape. The board never changes while
 * a piece is in flight, so the search only has to restore these three numbers.
 */
function scratchPiece(engine: Engine): Tetromino {
  return new Tetromino({
    symbol: engine.falling.symbol,
    initialRotation: engine.falling.rotation,
    boardHeight: engine.board.height,
    boardWidth: engine.board.width,
  });
}

function restore(piece: Tetromino, state: PieceState): void {
  piece.location = [state.location[0], state.location[1]];
  piece.rotation = state.rotation;
}

function applyMove(
  piece: Tetromino,
  move: MoveKey,
  board: Engine["board"]["state"],
  kickTable: Engine["kickTableName"],
): boolean {
  switch (move) {
    case "moveLeft":
      return piece.moveLeft(board);
    case "moveRight":
      return piece.moveRight(board);
    case "softDrop":
      return piece.softDrop(board);
    default:
      return Boolean(piece.rotate(board, kickTable, ROTATION_AMOUNT[move] as Rotation, false));
  }
}

/** The engine's spin judge: the route's kick only counts if the lock says so. */
function attackOf(lock: LockRes): number {
  return lock.garbage.reduce((total, value) => total + value, 0);
}

/**
 * Breadth-first map of every square the piece can reach, with a path to each.
 * Computed once per planner: the board cannot change while a piece is in
 * flight, so every question asked of one piece shares this walk.
 */
function reachableStates(engine: Engine): Map<string, ReachableState> {
  const board = engine.board.state;
  const kickTable = engine.kickTableName;
  const piece = scratchPiece(engine);

  const start = stateOf(engine.falling);
  const seen = new Map([[keyOf(start), { state: start, path: [] as MoveKey[] }]]);
  const frontier = [start];

  while (frontier.length > 0) {
    const current = frontier.shift()!;
    const path = seen.get(keyOf(current))!.path;
    for (const move of ALL_MOVES) {
      restore(piece, current);
      if (!applyMove(piece, move, board, kickTable)) continue;
      const next = stateOf(piece);
      const key = keyOf(next);
      if (seen.has(key)) continue;
      seen.set(key, { state: next, path: [...path, move] });
      frontier.push(next);
    }
  }
  return seen;
}

/**
 * Routes for one falling piece, against one board position.
 *
 * Cheap to hold: the reachability walk is the expensive part and the board
 * cannot change until the piece locks, so a caller keeps one planner per piece
 * and throws it away on the lock.
 */
export class RoutePlanner {
  private readonly board: Engine["board"]["state"];
  private readonly kickTable: Engine["kickTableName"];
  private readonly piece: Tetromino;
  private reachability: Map<string, ReachableState> | null = null;
  private readonly routeCache = new Map<string, MoveKey[][]>();
  private readonly placementCache = new Map<string, Placement | null>();
  private restingSeats: Map<string, { readonly cells: TargetCells; readonly path: MoveKey[] }> | null = null;

  /**
   * The falling piece this plan was built for.
   *
   * A plan is only true of the piece it walked from. The caller drops the
   * planner when the player presses a key — but a *held* direction key does not
   * press again, and the engine's own DAS/ARR keeps shifting the piece on every
   * tick, so the piece can leave the square this plan started from without any
   * input the caller sees. {@link matches} is how a caller notices.
   */
  private readonly builtFor: { readonly state: PieceState; readonly symbol: Tetromino["symbol"] };

  constructor(private readonly engine: Engine) {
    this.board = engine.board.state;
    this.kickTable = engine.kickTableName;
    this.piece = scratchPiece(engine);
    this.builtFor = { state: stateOf(engine.falling), symbol: engine.falling.symbol };
  }

  /**
   * Whether this plan still describes the piece on the board.
   *
   * Cheap enough to ask on every aim: two numbers, a rotation and a symbol.
   * False means the piece moved under the plan and every cached route in here
   * is answering about a square the piece has left.
   */
  matches(piece: Tetromino): boolean {
    const now = stateOf(piece);
    return (
      piece.symbol === this.builtFor.symbol &&
      now.rotation === this.builtFor.state.rotation &&
      now.location[0] === this.builtFor.state.location[0] &&
      now.location[1] === this.builtFor.state.location[1]
    );
  }

  private states(): Map<string, ReachableState> {
    this.reachability ??= reachableStates(this.engine);
    return this.reachability;
  }

  /**
   * Every distinct square the piece can be hard-dropped onto from here.
   *
   * The same breadth-first walk {@link routesTo} asks its questions of, read
   * for a different one: which of the states it found are *at rest*. A state
   * the piece cannot soft-drop out of is exactly a state a hard drop would
   * lock it in, and every state a hard drop passes through on the way down is
   * itself in the walk — so this is the complete set of placements, tucks and
   * spin seats included, with no second search and no separate notion of
   * reachability to drift from the one the game plays by.
   *
   * Complete **at the default soft drop**, which is the honest scope.
   * `Tetromino.softDrop` falls all the way to rest, which is what the engine
   * does at `sdf 41` and not what it does below it: there a held drop descends
   * `0.05 × sdf` rows a frame, so a player can stop part-way down and slide
   * under an overhang. Measured over the first piece of all 138 archive
   * puzzles, 4 boards have seats only a one-row-step walk reaches. Callers that
   * turn this into a claim — `searchSolutions`' `"exhausted"` — inherit that
   * scope and say so.
   *
   * Keyed by squares rather than by (x, y, rotation): an S piece flat on the
   * floor occupies the same four cells from two rotations, and they are one
   * placement, not two. That is the same equivalence `shared/solution-key.ts`
   * builds a solution's identity out of.
   *
   * The caller gets squares, not routes, because squares are what
   * {@link placementAt} takes — and it, not this, decides which kick lands the
   * piece, so an enumerated placement scores exactly what the same placement
   * would score if a player dragged the piece there.
   */
  restingPlacements(): TargetCells[] {
    return [...this.resting().values()].map((seat) => seat.cells);
  }


  /**
   * Every distinct route that lands the piece on `target`, best first.
   *
   * Routes ending in a rotation come first, because the engine only credits a
   * spin when the last input was one — and among those, different kicks earn
   * different spin bonuses, so callers replay the candidates and keep the
   * strongest. A route that simply arrives on the square comes last.
   */
  routesTo(target: TargetCells): MoveKey[][] {
    const wanted = cellsKey(target);
    const cached = this.routeCache.get(wanted);
    if (cached) return cached;

    const reachable = this.states();
    const occupies = (state: PieceState): boolean =>
      cellsKey(
        this.piece.absoluteAt({ x: state.location[0], y: state.location[1], rotation: state.rotation }),
      ) === wanted;

    const rotatedInto: MoveKey[][] = [];
    const arrivedFlat: MoveKey[][] = [];

    for (const { state, path } of reachable.values()) {
      if (occupies(state)) arrivedFlat.push(path);
      for (const move of ROTATION_MOVES) {
        restore(this.piece, state);
        if (!applyMove(this.piece, move, this.board, this.kickTable)) continue;
        if (occupies(stateOf(this.piece))) rotatedInto.push([...path, move]);
      }
    }

    const byLength = (a: MoveKey[], b: MoveKey[]) => a.length - b.length;
    const routes = [
      ...rotatedInto.sort(byLength).slice(0, MAX_ROTATION_CANDIDATES),
      ...arrivedFlat.sort(byLength).slice(0, 1),
    ];
    this.routeCache.set(wanted, routes);
    return routes;
  }

  /**
   * Every square the piece can be hard-dropped onto, with a route that gets it
   * there. Built once, because both questions asked of it are asked per
   * placement and the walk behind them is the same walk.
   */
  private resting(): Map<string, { readonly cells: TargetCells; readonly path: MoveKey[] }> {
    if (this.restingSeats) return this.restingSeats;
    const seats = new Map<string, { cells: TargetCells; path: MoveKey[] }>();
    for (const { state, path } of this.states().values()) {
      restore(this.piece, state);
      if (applyMove(this.piece, "softDrop", this.board, this.kickTable)) continue;
      const cells = this.piece.absoluteAt({
        x: state.location[0],
        y: state.location[1],
        rotation: state.rotation,
      });
      const key = cellsKey(cells);
      // Breadth-first, so the first arrival is the shortest one.
      if (!seats.has(key)) seats.set(key, { cells, path });
    }
    this.restingSeats = seats;
    return seats;
  }

  /**
   * A route that lands the piece on `target` without asking which kick is
   * worth most — the cheap answer, for when the expensive one cannot matter.
   *
   * {@link placementAt} is expensive because it plays every candidate rotation
   * out on the real engine and lets the lock judge it. That judgement only
   * changes the *spin* a placement is credited with, and a spin is only worth
   * something when lines come out with it: which rows complete is decided by
   * the squares the piece ends on, and those are the same on every route that
   * arrives here. So a caller that has already established nothing clears can
   * take any route that arrives and be sure it gave nothing up.
   */
  plainRouteTo(target: TargetCells): MoveKey[] | null {
    return this.resting().get(cellsKey(target))?.path ?? null;
  }

  /**
   * The strongest route that actually puts the piece on `target`: every
   * candidate is replayed through the real engine with a hard drop, and the
   * winner is the one whose lock lands on the target squares and earns the
   * most attack. Routes ending in a rotation usually win — a spin bonus the
   * engine credits is worth more than any shorter path — but the engine is the
   * judge, not the route's shape, and a kick that carries the piece somewhere
   * else is not a placement on this square no matter what it would have scored.
   *
   * This is the one definition of "placed on `target`". The build pipeline
   * replays archive solutions with it and the browser commits drags with it,
   * so a score the archive promises is a score the same code can produce.
   *
   * Candidates run as the timed batches {@link ticksForRoute} builds — the
   * exact shape the run's log takes when it commits — rather than `press`
   * calls. The two differ on one key: `press("softDrop")` drops the piece all
   * the way at once, while a tapped soft drop only holds for its own frame
   * and moves nothing, so a trial pressed through a mid-route soft drop lands
   * its kicks from a height the commit never reaches and promises a seat the
   * log cannot keep. Ticked trials can only promise what the log can do,
   * which is what keeps the hollow and the lock on the same squares.
   *
   * The engine is left exactly as it was found: candidates are tried against a
   * snapshot and the snapshot is restored, so a caller can go on playing (or
   * go on to commit its own route) from the same position.
   *
   * @returns null when nothing reaches the target and locks there.
   */
  placementAt(target: TargetCells): Placement | null {
    const wanted = cellsKey(target);
    const cached = this.placementCache.get(wanted);
    if (cached !== undefined) return cached;

    const placement = this.computePlacement(target, wanted);
    this.placementCache.set(wanted, placement);
    return placement;
  }

  private computePlacement(target: TargetCells, wanted: string): Placement | null {
    const routes = this.routesTo(target);
    if (routes.length === 0) return null;

    const before = this.engine.snapshot();
    let lastLock: LockRes | null = null;
    // The lock fires after the piece has stopped, when the engine is about to
    // spawn; the piece still carries its final squares at `lock.pre`, which is
    // the only moment they can be read off it.
    let lockedCells: TargetCells | null = null;
    const onPre = (): void => {
      lockedCells = this.engine.falling.absoluteBlocks.map(([x, y]) => [x, y] as const);
    };
    const onLock = (lock: LockRes): void => {
      lastLock = lock;
    };
    // A caller can be holding keys while aiming — a drag with a direction
    // held down — and the commit releases them before playing its route. The
    // trials open with the same releases, so they judge the route the commit
    // plays rather than the route plus a held key.
    this.engine.events.on("falling.lock.pre", onPre);
    this.engine.events.on("falling.lock", onLock);

    try {
      let best: Placement | null = null;
      let bestAttack = -1;
      for (const route of routes) {
        this.engine.fromSnapshot(before);
        lastLock = null;
        lockedCells = null;
        // The snapshot carries the live input state with it, so the releases
        // mirror the commit's even though every candidate restores first.
        const prefix = releaseTicks(this.engine, this.engine.frame);
        if (prefix.length > 0) this.engine.tick(prefix as never);
        for (const batch of ticksForRoute(route, this.engine.frame)) {
          this.engine.tick(batch as never);
        }
        if (!lastLock || !lockedCells) continue;
        if (cellsKey(lockedCells) !== wanted) continue;
        const attack = attackOf(lastLock);
        if (attack > bestAttack) {
          bestAttack = attack;
          best = { route };
        }
      }
      return best;
    } finally {
      this.engine.events.off("falling.lock.pre", onPre);
      this.engine.events.off("falling.lock", onLock);
      this.engine.fromSnapshot(before);
    }
  }

  /**
   * The piece translated so that one of its blocks **covers** the board cell
   * (`column`, `row`) — the drag gesture's target before gravity.
   *
   * A player points at the seat they mean: the nook of a staircase, the mouth
   * of a slot. Centring the piece's block-centroid over that cell would
   * satisfy the geometry and miss the meaning — for an S or a Z the centroid
   * sits on a half-cell boundary between blocks, so the piece drapes around
   * the pointed cell and lands one over. Covering the cell is the contract:
   * whatever locks is guaranteed to include the square the finger named.
   *
   * Up to four translations cover a cell (one per block, fewer on symmetric
   * shapes). The nearest to where the piece stands now wins — a drag should
   * nudge, not fling — with ties broken toward staying level, then toward
   * the left. Candidates are compared **after** clamping: the clamp keeps the
   * shape on the board, and a shift that only covers the cell by leaving the
   * board loses to one that covers it legally, so a solid preview never names
   * a square it does not contain. How the piece then seats itself — soft
   * drop, a kick — is the engine's business, not the finger's; the finger
   * names a square and the rotation the player has already chosen.
   *
   * `prefer` keeps a drag steady: while the finger stays inside the hollow it
   * already saw, the hollow stays put instead of re-centring under the finger.
   * The caller passes the previous aim, and the candidate overlapping it most
   * wins before nearness is consulted. A fresh gesture passes nothing and gets
   * the nearest cover. Rotation changes void the aim upstream, so the overlap
   * always compares like with like.
   *
   * Both axes are clamped only to keep the shape on the board, in every
   * direction: a piece rotated upright is aimed *below* its spawned
   * footprint, which is how a slot under the sky gets filled.
   */
  targetAt(column: number, row: number, prefer?: TargetCells | null): TargetCells {
    const cells = this.engine.falling.absoluteBlocks.map(([x, y]) => [x, y] as const);
    const lowestX = Math.min(...cells.map(([x]) => x));
    const highestX = Math.max(...cells.map(([x]) => x));
    const lowestY = Math.min(...cells.map(([, y]) => y));
    const highestY = Math.max(...cells.map(([, y]) => y));
    const clamp = (shift: number, lowest: number, highest: number, max: number): number =>
      Math.max(-lowest, Math.min(max - 1 - highest, shift));

    const preferred = prefer ? new Set(prefer.map(([x, y]) => `${x}:${y}`)) : null;

    interface Candidate {
      readonly cells: TargetCells;
      readonly covers: boolean;
      readonly overlap: number;
      /** Nearest first: Manhattan, then level, then the shorter drop, then left. */
      readonly rank: readonly [number, number, number, number];
    }

    let best: Candidate | null = null;
    const isBetter = (a: Candidate, b: Candidate): boolean => {
      if (a.covers !== b.covers) return a.covers;
      if (a.overlap !== b.overlap) return a.overlap > b.overlap;
      for (let index = 0; index < a.rank.length; index++) {
        if (a.rank[index] !== b.rank[index]) return a.rank[index]! < b.rank[index]!;
      }
      return false;
    };
    // One candidate translation per block: the shift that sets *that block*
    // down on the named cell, kept on the board.
    for (const [x, y] of cells) {
      const shiftX = clamp(column - x, lowestX, highestX, this.engine.board.width);
      const shiftY = clamp(row - y, lowestY, highestY, this.engine.board.height);
      const moved = cells.map(([cx, cy]) => [cx + shiftX, cy + shiftY] as const);
      const covers = moved.some(([cx, cy]) => cx === column && cy === row);
      const overlap = preferred ? moved.filter(([cx, cy]) => preferred.has(`${cx}:${cy}`)).length : 0;
      const rank: Candidate["rank"] = [
        Math.abs(shiftX) + Math.abs(shiftY),
        Math.abs(shiftX),
        Math.abs(shiftY),
        shiftX,
      ];
      const candidate: Candidate = { cells: moved, covers, overlap, rank };
      if (!best || isBetter(candidate, best)) best = candidate;
    }
    return best!.cells;
  }
}

/**
 * Every distinct route that lands the piece on `target`, best first.
 *
 * Convenience for one-off questions — the build pipeline and anything playing a
 * run should hold a {@link RoutePlanner} instead, so repeated asks (candidate
 * selection, a drag following a finger) share one reachability walk.
 */
export function findPaths(engine: Engine, target: TargetCells): MoveKey[][] {
  return new RoutePlanner(engine).routesTo(target);
}
