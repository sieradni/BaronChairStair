/**
 * The run: one attempt at one puzzle.
 *
 * Owns an engine, a fixed-timestep clock, and the log of every key the player
 * pressed. The log is the only thing sent to the server — the score is whatever
 * the server gets when it replays those keys, so this class never has to be
 * trusted, only correct.
 */

import type { Engine } from "@haelp/teto/engine";
import type { PieceLedger } from "@shared/tetris/ledger";
import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  ENGINE_ROWS,
  type BoardCell,
  type ClearName,
  decodeBoard,
  solvesPuzzle,
  type Mino,
  pieceBudget,
  type PuzzlePrompt,
} from "@shared/puzzle";
import { createPuzzleEngine, readBoard, toLetter } from "@shared/tetris/engine";
import type { Handling } from "@shared/tetris/handling";
import { RoutePlanner, releaseTicks, ticksForRoute, type TargetCells } from "@shared/tetris/pathfinder";
import {
  clearsOf,
  creditPlacements,
  type ScoredPlacement,
  total,
} from "@shared/tetris/credit";
import { nameClear } from "@shared/tetris/replay";
import type { GameKey, InputEvent } from "@shared/tetris/verify";
import { MAX_EVENTS, MAX_FRAMES } from "@shared/tetris/verify";
import type { BoardView } from "../render/board";
import { MINO_INK } from "../render/skin";

const FRAME_MS = 1000 / 60;

/** Normalizes a cell list to its own bounding box, sorted for comparison. */
function normalizeCells(
  cells: readonly (readonly [number, number])[],
): (readonly [number, number])[] {
  const mx = Math.min(...cells.map(([x]) => x));
  const my = Math.min(...cells.map(([, y]) => y));
  return cells
    .map(([x, y]) => [x - mx, y - my] as const)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

/**
 * One quarter-turn clockwise of a cell list, normalized to its own bounding
 * box. Board rows count UP from the floor (y-down on screen), so the screen's
 * clockwise is `(x, y) → (y, w-1-x)`: the cell's height above the floor
 * becomes its distance from the left edge.
 */
function spinCW(cells: readonly (readonly [number, number])[]): (readonly [number, number])[] {
  const w = Math.max(...cells.map(([x]) => x)) + 1;
  return normalizeCells(cells.map(([x, y]) => [y, w - 1 - x] as const));
}

function sameCells(
  a: readonly (readonly [number, number])[],
  b: readonly (readonly [number, number])[],
): boolean {
  return a.length === b.length && a.every(([x, y], i) => b[i]![0] === x && b[i]![1] === y);
}

/**
 * How many clockwise quarter-turns spin `from` onto `to` — same shape, same
 * orientation, translation ignored — or null when the two are not the same
 * piece at all. Pure geometry on cells: the engine is never asked about its
 * internal rotation state, because the park's orientation was earned by the
 * same piece before the undo.
 */
export function cwTurnsBetween(
  from: readonly (readonly [number, number])[],
  to: readonly (readonly [number, number])[],
): number | null {
  const target = normalizeCells(to);
  let spun = normalizeCells(from);
  for (let k = 0; k < 4; k++) {
    if (sameCells(spun, target)) return k;
    spun = spinCW(spun);
  }
  return null;
}
/** Seconds a released, legal preview must rest before the carry commits it. */
const REST_SECONDS = 0.75;
/** Seconds the drawn completion ring spends fading once the commit is made. */
const RING_FADE_SECONDS = 0.35;
/** After a tab-away, catch up at most this much rather than freezing. */
const MAX_CATCHUP_MS = 250;
const FLASH_MS = 220;
/** The keys that turn the piece rather than move it. */
const ROTATIONS = new Set<GameKey>(["rotateCW", "rotateCCW", "rotate180"]);

export type RunPhase = "ready" | "playing" | "solved" | "failed";

export interface RunSnapshot {
  readonly phase: RunPhase;
  readonly attack: number;
  readonly targetAttack: number;
  readonly piecesPlaced: number;
  readonly pieceBudget: number;
  readonly clears: readonly ClearName[];
  /** Wall clock since the puzzle was opened, across every attempt. */
  readonly elapsedMs: number;
  readonly resets: number;
  readonly hold: Mino | null;
  readonly upcoming: readonly Mino[];
  readonly holdLocked: boolean;
}

export interface RunCallbacks {
  /** Called every rendered frame with the state to draw. */
  readonly onFrame: (view: BoardView, snapshot: RunSnapshot) => void;
  /** Called once when the attempt ends, with the log to submit. */
  readonly onFinish: (snapshot: RunSnapshot, events: readonly InputEvent[]) => void;
  readonly onLock: (clear: ClearName | null, attack: number) => void;
}

/**
 * Where a placement left the log: how long it was, and the frame it locked on.
 *
 * The frame is the half undo cannot do without. A key held through the lock has
 * to be let go of after that lock, not at the keypress that started it.
 */
interface Checkpoint {
  readonly length: number;
  readonly frame: number;
  /**
   * The squares the placement locked on. Undo hands the piece back there —
   * the virtual position the player had arranged, not wherever the rebuilt
   * engine happens to hang the next piece. Empty for a hold boundary: a swap
   * hands the piece back through the swap itself, and undo parks nothing.
   */
  readonly seat: TargetCells;
}

/** A square on the board a gesture is pointing at. */
export interface BoardSpot {
  readonly column: number;
  readonly row: number;
}

/** What undo took out of the log, and what it put back in to close the rest. */
interface UndoneSegment {
  readonly events: readonly InputEvent[];
  /** Keyups undo appended, dropped again so redo restores the log verbatim. */
  readonly closers: number;
  /**
   * Rotation pairs undo appended AFTER the closers to spin the physical
   * piece onto the park's orientation — dropped again so redo restores the
   * log the player played, byte for byte.
   */
  readonly sync: number;
  readonly checkpoint: Checkpoint;
}

/** The keys a log leaves down, in the order they were first touched. */
function keysHeldAfter(events: readonly InputEvent[]): GameKey[] {
  const state = new Map<GameKey, boolean>();
  for (const event of events) state.set(event.data.key, event.type === "keydown");
  return [...state].flatMap(([key, down]) => (down ? [key] : []));
}

/**
 * Keyups that release everything `events` leaves held, as of `frame`.
 *
 * The frame is the one the placement locked on rather than the last event's: a
 * piece seated with soft drop locks well after the key that seated it, so
 * releasing at the keypress would replay a piece that never lands. Subframe
 * zero puts the release before that frame's gravity, leaving the piece the lock
 * spawned exactly where the engine put it.
 */
function closingKeyups(events: readonly InputEvent[], frame: number): InputEvent[] {
  return keysHeldAfter(events).map((key) => ({
    // Clamped because the server parses this log under its own bounds, and a
    // synthetic event has to sit inside them like every typed one.
    frame: Math.min(frame, MAX_FRAMES),
    type: "keyup" as const,
    data: { key, subframe: 0 },
  }));
}

export class PuzzleRun {
  private engine!: Engine;
  private ledger!: PieceLedger;
  /** The full log, submitted at the end. */
  private events: InputEvent[] = [];
  /** Events not yet handed to the engine, drained on the next tick. */
  private pending: InputEvent[] = [];
  private readonly held = new Set<GameKey>();

  private phase: RunPhase = "ready";
  private accumulator = 0;
  private lastTimestamp = 0;
  private rafHandle = 0;

  private attack = 0;
  private piecesPlaced = 0;
  private clears: ClearName[] = [];
  /**
   * Every placement the puzzle's own pieces have made, with what the engine
   * gave it at the time.
   *
   * The verdict is taken on these rather than on the running totals, because
   * the same squares can score two ways depending on the kick that reached
   * them and the puzzle's target was set by the better one. See `credit.ts`.
   */
  private placed: ScoredPlacement[] = [];
  /** Squares the falling piece is about to lock on, read on the way in. */
  private cellsBeforeLock: TargetCells = [];
  /** Whether {@link solved} has already re-scored the list as it now stands. */
  private credited = false;
  private resets = 0;
  private firstInputFrame: number | null = null;
  /**
   * Where each placement left the log.
   *
   * Undo cuts the log back to a placement boundary and replays what is left,
   * which is why undo needs no server support at all: a shortened log is still
   * an ordinary log, and the server verifies it the way it verifies every
   * other one. There is nothing to tell it about.
   */
  private checkpoints: Checkpoint[] = [];
  /** Segments undo removed, newest last, so redo can put them back. */
  private undone: UndoneSegment[] = [];
  /** True while the log is being fed back in, to keep the replay silent. */
  private replaying = false;
  private finishedAt: number | null = null;

  private flashRows: number[] = [];
  private pendingFlash: number[] = [];
  private flashUntil = 0;

  /**
   * Route search for the piece in flight, thrown away on the lock — the board
   * the search walked no longer exists once a piece lands in it.
   */
  private planner: RoutePlanner | null = null;
  /** Where a finger or pointer is aiming the piece, and whether it can go. */
  private aim: { cells: TargetCells; legal: boolean } | null = null;
  /**
   * Where the last on-board release parked the piece: an aim it could not
   * place. The preview keeps showing it — drawn dashed, on top of whatever
   * it overlaps — so the player can see and correct the obstruction, and the
   * next drag starts from this seat (the spec's "start from the current
   * preview position"). Nothing was spent: the falling piece keeps falling
   * underneath from its natural seat, and a lock clears the park with it.
   * Cleared by keys, undo, redo, restart and lock alike.
   */
  private parked: { cells: TargetCells } | null = null;
  /**
   * The cells a live drag carries, captured at the grab.
   *
   * The drag's shift is applied to these — the piece's position when the
   * drag took hold, a parked preview seat included — never to the falling
   * piece as it stands now: the preview is exactly where the finger says,
   * relative to where the drag started, and gravity keeps doing what it was
   * doing underneath. Any invalidation (a key, a lock, an undo, a restart)
   * nulls this, which turns the drag inert until its release: the finger's
   * correspondence was with a piece that no longer exists.
   */
  private carryBase: { cells: TargetCells } | null = null;
  /**
   * The rows the grab dropped the piece to reach the shadow — its resting
   * seat — remembered so the carried shift applies from there. A parked
   * grab re-anchors on the park itself, which needs no drop.
   */
  private carryDrop = 0;
  /**
   * Column compensation from rotations taken mid-carry: the preview's seat
   * is preserved across a rotation by re-cornering the rotated piece onto
   * it, and the column part of that cannot ride the drop (rows only). The
   * finger's own shift keeps measuring from the press; this slides the
   * anchor so the seat the player was watching stays where it was.
   */
  private carrySlide = 0;
  /**
   * The shift the last carry applied — the finger's amplified travel from
   * the press, as the run sees it. The tracker owns the live value; this
   * remembered copy is what lets a mid-carry rotation re-derive the seat
   * the shift had produced (the tracker's next shift continues from the
   * same press, so anchoring against it keeps the seat steady).
   */
  private carryShift: { column: number; row: number } = { column: 0, row: 0 };
  /**
   * The lock gate: a legal released seat whose commit is waiting out its
   * rest. Cancelled by anything that makes the seat a memory: a re-grab, a
   * key, an undo, a lock, a restart.
   */
  private restGate: { cells: TargetCells; restFor: number } | null = null;
  /** The finished commit's ring, fading on the board where it locked. */
  private restRing: { cells: TargetCells; restFor: number } | null = null;
  /**
   * The pointer contacts currently down, as the surface reports them.
   *
   * Not engine state — a hand on the piece. The rest gate reads it, because
   * the rest is the time the hand spends OFF the piece: under a finger the
   * wait must not count, or the piece commits while the player is still
   * holding it and their next gesture acts on the piece after it.
   */
  private contactsDown = 0;
  /**
   * An accepted hold press whose swap the engine has yet to apply, with the
   * two piece states that tell whether it did.
   *
   * The swap's undo boundary is recorded when the trade has actually been
   * made, not at the keyup: ordinary key rollover (hold down, hard drop,
   * hold up) puts the keyup after the placement's own boundary, which made
   * the first undo a silent no-op and the second revert the placement and the
   * swap together — the exact desync the boundary exists to prevent.
   */
  private pendingHold: {
    held: Engine["held"];
    falling: ReturnType<typeof toLetter>;
  } | null = null;
  /**
   * True while the planner is trying routes against the real engine.
   *
   * A trial replay locks pieces, and every lock fires this run's listeners —
   * which would count the trial's piece against the puzzle, move the undo
   * boundary and maybe even end the attempt. Trials are invisible fictions:
   * the snapshot is restored afterwards and nothing they did happened.
   */
  private trialing = false;
  /**
   * True while a rotation is being applied to the seat by hand rather than by
   * the player's key: a pointer tap's in-place turn, or the undo's sync spin
   * that walks the re-spawned piece onto its park's orientation.
   *
   * Both read the corner, play the key and re-derive the seat themselves, so
   * the key path must not turn the seat a second time on its way through
   * {@link input}.
   */
  private seatByHand = false;

  readonly visibleRows: number;
  private readonly budget: number;

  constructor(
    private readonly puzzle: PuzzlePrompt,
    /**
     * Frozen for the life of the attempt. The server replays the whole input
     * log under one handling, so an attempt played under two would be scored
     * as a game the player never played.
     */
    readonly handling: Handling,
    private readonly callbacks: RunCallbacks,
    /** Restarts carried over from earlier attempts at the same puzzle. */
    startingResets = 0,
    /**
     * When the player first saw this puzzle. Carried across restarts, because
     * the time that matters is time spent on the puzzle, not on one attempt.
     */
    private readonly startedAt = Date.now(),
  ) {
    this.resets = startingResets;
    this.budget = pieceBudget(puzzle);
    this.visibleRows = BOARD_HEIGHT;
    this.build();
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  private get setup() {
    return {
      board: decodeBoard(this.puzzle.board, ENGINE_ROWS),
      queue: this.puzzle.queue,
      hold: this.puzzle.hold,
    };
  }

  private build(): void {
    ({ engine: this.engine, ledger: this.ledger } = createPuzzleEngine(this.setup, this.handling));
    this.planner = null;
    this.aim = null;
    this.parked = null;
    this.endCarry();
    this.restGate = null;
    this.restRing = null;
    this.pendingHold = null;
    this.trialing = false;
    this.engine.events.on("falling.lock.pre", () => {
      if (this.trialing) return;
      this.pendingFlash = this.rowsAboutToClear();
      // The falling piece is replaced before `falling.lock` fires, so its
      // squares are read on the way in. They are what the run is credited on —
      // see `credit.ts`.
      this.cellsBeforeLock = this.engine.falling.absoluteBlocks.map(([x, y]) => [x, y] as const);
    });
    this.engine.events.on("falling.lock", (lock) => {
      if (this.trialing) return;
      // The board the planner walked is gone the moment a piece lands in it.
      this.planner = null;
      this.aim = null;
      this.parked = null;
      this.endCarry();
      this.restGate = null;
      this.restRing = null;
      const piece = toLetter(lock.mino);
      // A piece the ledger cannot account for is the engine's padding, not the
      // puzzle's. It never counts and it always ends the run.
      if (piece === null || piece === "G" || !this.ledger.spend(piece)) {
        this.finish(this.solved() ? "solved" : "failed");
        return;
      }
      this.piecesPlaced++;
      const attack = lock.garbage.reduce((total, value) => total + value, 0);
      this.attack += attack;
      const clear = nameClear(lock, this.engine.board.perfectClear);
      if (clear) this.clears.push(clear);
      // Kept so the verdict can be taken on the placements rather than on the
      // route that reached them. Appended here, inside the ledger's own guard,
      // so the engine's padding never joins the list.
      this.placed.push({ piece, cells: this.cellsBeforeLock, clear, attack });
      // A re-score is only ever as good as the list it reads, and the list has
      // just grown.
      this.credited = false;
      // Only a live placement moves the boundary. During a replay the log is
      // already whole, so `events.length` is its total rather than the
      // position reached — recording it would collapse every checkpoint onto
      // the same value and the second undo would truncate nothing.
      //
      // The lock frame is recorded alongside the length because a boundary is
      // only worth returning to if the player can play on from it, and a prefix
      // that ends mid-keypress cannot: undo needs a frame after the lock at
      // which to release whatever was still being held when it happened.
      if (!this.replaying) {
        this.checkpoints.push({
          length: this.events.length,
          frame: this.engine.frame,
          seat: this.cellsBeforeLock.map(([x, y]) => [x, y] as const),
        });
      }
      // A replay is re-reaching a position the player already saw. Flashing
      // every line it clears again, and calling back for each, would replay
      // the noise as well as the placements.
      if (!this.replaying) {
        if (clear) {
          this.flashRows = this.pendingFlash;
          this.flashUntil = performance.now() + FLASH_MS;
        }
        this.callbacks.onLock(clear, this.attack);
      }
      this.checkForEnd();
    });
  }

  /**
   * Rows that the piece about to lock will complete. Read before the lock,
   * because the engine removes cleared rows before reporting them.
   */
  private rowsAboutToClear(): number[] {
    const { falling, board } = this.engine;
    const cells = falling.absoluteBlocks;
    const occupied = new Set(cells.map(([x, y]) => `${x},${y}`));
    const candidates = new Set(cells.map(([, y]) => y));
    return [...candidates].filter((y) =>
      Array.from({ length: BOARD_WIDTH }, (_, x) => x).every(
        (x) => occupied.has(`${x},${y}`) || board.occupied(x, y),
      ),
    );
  }

  /** Discards the attempt and starts over. Counts against the shared reset tally. */
  restart(): void {
    if (this.phase === "solved") return;
    this.stopLoop();
    this.resets++;
    this.events = [];
    this.pending = [];
    this.held.clear();
    this.aim = null;
    this.attack = 0;
    this.piecesPlaced = 0;
    this.clears = [];
    this.placed = [];
    this.credited = false;
    this.checkpoints = [];
    this.undone = [];
    this.firstInputFrame = null;
    this.phase = "ready";
    this.flashRows = [];
    this.build();
    this.renderOnce();
  }

  // ── Undo and redo ──────────────────────────────────────────────────────────

  get canUndo(): boolean {
    return this.checkpoints.length > 0 && this.phase !== "solved" && this.phase !== "failed";
  }

  get canRedo(): boolean {
    return this.undone.length > 0 && this.phase !== "solved" && this.phase !== "failed";
  }

  /**
   * Takes back the last placement — or a hold swap newer than it. Returns
   * false when there is nothing to take.
   */
  undo(): boolean {
    // A refusal is still a key: the keyboard plays the physical piece, so
    // even when there is no placement to take back, a waiting seat dies
    // with the press — the same invalidation any key performs. Nothing is
    // cut from the log, because nothing was ever taken.
    if (!this.canUndo) {
      if (this.restGate) {
        this.restGate = null;
        this.restRing = null;
        this.aim = null;
        this.endCarry();
        this.renderOnce();
      }
      return false;
    }
    this.parked = null;
    this.restGate = null;
    this.restRing = null;
    const boundary = this.checkpoints[this.checkpoints.length - 2];
    const target = boundary?.length ?? 0;
    // A checkpoint is a prefix of the log, not a closed one: the lock that
    // recorded it happened mid-frame, so a key that was down at that instant
    // has its press inside the prefix and its release in the part being thrown
    // away. Replayed as it stands, the prefix leaves that key down for good —
    // the engine goes on acting on it, and `input` reads the player's real
    // release as a repeat and drops it.
    const closers = boundary ? closingKeyups(this.events.slice(0, target), boundary.frame) : [];
    // Refusing to undo beats returning to a position whose log the server would
    // reject as too long.
    if (target + closers.length > MAX_EVENTS) return false;

    const checkpoint = this.checkpoints.pop()!;
    const removed = this.events.splice(target);
    this.events.push(...closers);
    // The boundary ends after the closers now, so a later undo back to it lands
    // on a log that is already closed and needs no second set.
    if (boundary) {
      this.checkpoints[this.checkpoints.length - 1] = { ...boundary, length: this.events.length };
    }
    this.undone.push({ events: removed, closers: closers.length, sync: 0, checkpoint });
    this.rebuildFromLog();
    // Hand the piece back where the undone placement had locked it: the
    // virtual position the player arranged survives the take-back, shown
    // as a parked preview — the same dashed, grabbable seat a release on
    // an unplaceable square leaves — rather than spent and forgotten.
    // A grab from there re-anchors on the seat, so a slam (or any carry)
    // continues from the position that was taken back.
    // A hold boundary parks nothing — the swap IS the hand-back: the held
    // piece is already falling again, exactly where the player had it. A
    // placement boundary parks its seat and spins the physical piece to
    // match it.
    if (checkpoint.seat.length > 0) {
      this.parked = { cells: checkpoint.seat };
      // The park is not just drawn — the physical piece is SPUN onto its
      // orientation, here at the undo, so virtual and physical agree from the
      // first frame: the 180 the player took back shows a 180ed piece under
      // it, and the next rotateCW rotates both CW normally. The sync events
      // are real log events — the server replays and verifies them like any
      // other input — and they are recorded on the segment so redo can strip
      // them and restore the log the player actually played.
      const sync = this.syncPhysicalToPark();
      if (sync > 0) {
        const segment = this.undone[this.undone.length - 1]!;
        this.undone[this.undone.length - 1] = { ...segment, sync };
        // The boundary moves past the sync events too, so a later undo cuts
        // back to a log that is still closed.
        if (boundary) {
          this.checkpoints[this.checkpoints.length - 1] = {
            ...boundary,
            length: this.events.length,
          };
        }
      }
    }
    this.renderOnce();
    return true;
  }

  /**
   * Spins the falling piece to the parked preview's orientation.
   *
   * The park and the piece must show the same orientation or the next
   * rotation tap visibly desyncs them — the seat snapping one way while the
   * piece turns another. The piece is driven there with real rotateCW pairs
   * through {@link input} (the undo log's own path, server-replayable),
   * then the queues are flushed so the engine state matches before anything
   * reads it.
   *
   * Returns the number of sync events appended (zero when the piece already
   * sits at the park's orientation — the O in any state — or is not the
   * park's piece at all, in which case nothing is played).
   *
   * `parked` and `undone` are restored across the sync: {@link input}
   * nulls the park and clears the redo stack, and these silent
   * housekeeping keys are neither a player action nor a verdict on the
   * take-back — the park stands, and undo of the undo is still waiting.
   */
  private syncPhysicalToPark(): number {
    if (!this.parked) return 0;
    const park = this.parked;
    const turns = cwTurnsBetween(this.engine.falling.absoluteBlocks, park.cells);
    if (!turns) return 0; // zero turns: nothing to do; null: not the park's piece
    const undone = this.undone;
    this.undone = [];
    const before = this.events.length;
    // By hand, like a tap: the park IS the orientation being walked to, and the
    // key path must not turn it a second time.
    this.seatByHand = true;
    try {
      for (let i = 0; i < turns; i++) {
        this.input("rotateCW", true);
        this.input("rotateCW", false);
      }
    } finally {
      this.seatByHand = false;
    }
    this.undone = undone;
    this.flushPending();
    this.parked = park; // the sync inputs nulled it; the park stands
    return this.events.length - before;
  }

  /** Puts back the placement undo took, if nothing has been played since. */
  redo(): boolean {
    if (!this.canRedo) return false;
    this.parked = null;
    this.restGate = null;
    this.restRing = null;
    const segment = this.undone.pop()!;
    // Undo's closers were never typed, and its sync spins never played by the
    // player. Taking them back out before the player's own events go back
    // makes a redone log the one they played, byte for byte.
    this.events.splice(this.events.length - segment.closers - segment.sync, segment.closers + segment.sync);
    const boundary = this.checkpoints[this.checkpoints.length - 1];
    if (boundary) {
      this.checkpoints[this.checkpoints.length - 1] = { ...boundary, length: this.events.length };
    }
    // One undone segment is exactly one placement, and it restores the boundary
    // it was taken from rather than the end of the log: keys pressed after that
    // lock belong to the next placement, not to this one.
    this.checkpoints.push(segment.checkpoint);
    this.events.push(...segment.events);
    this.rebuildFromLog();
    return true;
  }

  /**
   * Rebuilds the position from the log, the way the server would.
   *
   * A fresh engine fed the whole log is the only rewind that cannot drift:
   * unwinding the board in place would mean undoing a line clear, a spin
   * bonus and a hold swap by hand, and any one of those getting it slightly
   * wrong would put the player on a board the server does not agree exists.
   * Replaying costs well under a millisecond at this length.
   */
  private rebuildFromLog(): void {
    this.stopLoop();
    this.attack = 0;
    this.piecesPlaced = 0;
    this.clears = [];
    this.placed = [];
    this.credited = false;
    this.pending = [];
    // Folded from the log rather than emptied: `input` treats `held` as the
    // truth about what is down, so a set that disagrees with the log turns the
    // player's next release of that key into a repeat and swallows it.
    this.held.clear();
    for (const key of keysHeldAfter(this.events)) this.held.add(key);
    this.flashRows = [];
    this.phase = "ready";
    this.build();

    this.replaying = true;
    try {
      let cursor = 0;
      while (cursor < this.events.length && this.engine.frame <= MAX_FRAMES) {
        const batch: InputEvent[] = [];
        while (cursor < this.events.length && this.events[cursor]!.frame === this.engine.frame) {
          batch.push(this.events[cursor]!);
          cursor++;
        }
        this.engine.tick(batch as never);
      }
    } finally {
      this.replaying = false;
    }

    if (this.phase === "ready" && this.events.length > 0) {
      this.phase = "playing";
      this.lastTimestamp = performance.now();
      this.accumulator = 0;
      this.startLoop();
    }
    this.renderOnce();
  }

  dispose(): void {
    this.stopLoop();
    this.planner = null;
    this.aim = null;
    this.parked = null;
    this.endCarry();
    this.restGate = null;
    this.restRing = null;
    this.engine.events.removeAllListeners();
  }

  /** Whether the attempt is driving its own frame loop. */
  get isRunning(): boolean {
    return this.phase === "playing";
  }

  /**
   * The log so far, mid-attempt.
   *
   * A rush needs this: a puzzle left behind by the buzzer or by a skip never
   * reaches `onFinish`, but its inputs are still part of the submission.
   */
  log(): readonly InputEvent[] {
    return this.events;
  }

  // ── Input ──────────────────────────────────────────────────────────────────

  /**
   * Records a key transition. Repeats from the operating system are ignored —
   * the engine runs its own auto-repeat from the player's DAS and ARR.
   */
  input(key: GameKey, down: boolean): void {
    // Before anything reads the ledger, and before the phase guard, because
    // flushing can end the attempt and the guard below is what should notice.
    // A hold is screened on how many pieces the puzzle still owes, and that
    // count is a frame out of date until the pending ticks are applied: a hold
    // pressed in the same animation frame as the hard drop that spends the
    // second-to-last piece would otherwise be judged against the count from
    // before that drop and sail through — the whole bug, on the one input
    // timing a player hurrying to the end is most likely to produce.
    if (key === "hold" && down && (this.phase === "ready" || this.phase === "playing")) {
      this.flushPending();
    }
    if (this.phase === "solved" || this.phase === "failed") return;
    // A hold with one piece left has nothing to trade with, and the engine
    // would answer it out of the padding beyond the queue — handing the player
    // a tetromino the puzzle never offered. Dropped here rather than let
    // through and caught at the lock, because by then they have already been
    // shown it. Only a PRESS can hand out a piece the puzzle never offered: a
    // release is bookkeeping, and dropping one would leave the key down in the
    // log forever — which is what silently ate the swap's undo boundary when
    // the lock before it spent the second-to-last piece.
    if (key === "hold" && down && !this.ledger.canSwap) return;
    if (down === this.held.has(key)) return;
    if (down) this.held.add(key);
    else this.held.delete(key);
    // The piece is about to move under keys, so any drag target computed for
    // the piece as it stood is a lie about a piece that no longer exists. The
    // planner goes with it: it walked the board from a starting square that
    // is being abandoned. A drag still in progress re-aims on its next move.
    // The keyboard plays the PHYSICAL piece, and this is the whole contract:
    // a key cancels every virtual position — the drag's preview, the seat a
    // rest gate is holding, a parked seat — and acts on the piece itself,
    // wherever it actually is. A hard drop during the wait hard-drops the
    // falling piece from spawn; a rotation turns it there. The player is
    // looking at the piece when their hands are on the keys, so the keys
    // are never allowed to act on a seat they are not looking at.
    this.aim = null;
    this.parked = null;
    this.endCarry();
    this.restGate = null;
    this.restRing = null;
    this.planner = null;

    if (this.phase === "ready") this.begin();
    // The log is what gets scored, so once it is full the attempt is over —
    // continuing to accept input would leave the player driving a board whose
    // moves the server will never see.
    if (this.events.length >= MAX_EVENTS) {
      this.finish(this.solved() ? "solved" : "failed");
      return;
    }

    // How far into the current frame the tick loop had got when this key
    // arrived. It is the accumulator as of the last completed tick rather than
    // the instant of the keypress, so it is coarser than true sub-frame timing
    // — but it is the value that goes in the log, so the server replays exactly
    // what the client played.
    const subframe = Math.min(0.999, Math.max(0, this.accumulator / FRAME_MS));
    const frame = this.engine.frame;
    this.firstInputFrame ??= frame;
    const event: InputEvent = {
      frame,
      type: down ? "keydown" : "keyup",
      data: { key, subframe: Number(subframe.toFixed(3)) },
    };
    // Playing on after an undo is the player choosing this line over the one
    // they took back, so there is no longer a forward to redo into.
    this.undone = [];
    this.events.push(event);
    this.pending.push(event);
    // A completed hold swap opens its own undo boundary. Without it the swap
    // rides inside the NEXT placement's undo segment: the first undo would
    // take the hold back too — the held piece re-spawning while the parked
    // preview still describes the placement's seat, a J-shaped ghost over a
    // physical Z. The boundary cannot be recorded here, at the press: the
    // engine has still to make the trade, and with ordinary key rollover the
    // release arrives after the placement that follows it. The press is
    // marked, and {@link settleHoldBoundary} records the boundary on the tick
    // that actually performs the swap — so undoing a placement keeps the swap
    // that handed the player the piece they placed, and a second undo reverts
    // the swap itself.
    if (key === "hold" && down) {
      this.pendingHold = {
        held: this.engine.held,
        falling: toLetter(this.engine.falling.symbol),
      };
    }
  }

  // ── Pointer play ───────────────────────────────────────────────────────

  /** True while a drag is aiming the piece somewhere. */
  get isAiming(): boolean {
    return this.aim !== null;
  }

  /**
   * Stands the drag's own state down — anchor, shadow drop, rotation slide
   * and the finger's remembered shift. Used wherever the piece under the
   * drag stops being the one the finger grabbed: a key move, a settle, a
   * slam, a rebuild. The preview and the park are the callers' business.
   */
  private endCarry(): void {
    this.carryBase = null;
    this.carryDrop = 0;
    this.carrySlide = 0;
    this.carryShift = { column: 0, row: 0 };
  }

  /**
   * A pointer contact landed: the rest gate stops counting while it is down.
   *
   * The gate keeps its seat — the arrangement is still the player's — but the
   * wait it measures is time spent with the hand off the piece, which is the
   * whole of what makes the commit deliberate.
   */
  contactDown(): void {
    this.contactsDown++;
  }

  /**
   * A contact lifted: with the last one up, a waiting rest starts over.
   *
   * Measured from the last release rather than from the release that opened
   * the gate, because a finger that came back down took the decision back with
   * it. Nothing is spent by the restart: the seat waits as long as the player
   * keeps arranging.
   */
  contactUp(): void {
    this.contactsDown = Math.max(0, this.contactsDown - 1);
    if (this.contactsDown === 0 && this.restGate) {
      this.restGate = { cells: this.restGate.cells, restFor: performance.now() };
    }
  }

  /**
   * A key press as one event pair: down and up inside the same frame.
   *
   * A rotation tap does not end a drag: it is part of arranging the carry,
   * so the drag survives it — the preview seat's corner is read, the
   * rotated piece becomes the anchor, and the preview re-derives from the
   * same travel onto that corner.
   */
  tap(key: GameKey): void {
    const rotating = ROTATIONS.has(key);
    // The virtual position to preserve, as its bottom-left corner: rotation
    // re-derives the carry from the rotated piece without letting the seat
    // jump. The position is the live drag's shown preview — a dangling aim
    // after a key move included — or, while the piece is locking, the seat
    // the gate is holding: the rotation still CANCELS the wait (a key is a
    // key), but the arranged seat must rotate in place, not teleport back
    // to the piece's physical shadow. Read before the input: the input
    // invalidates the carry, the aim and the gate by design.
    const anchor =
      this.carryBase ??
      (this.restGate ? { cells: this.restGate.cells } : null);
    const corner =
      anchor && rotating
        ? {
            column:
              Math.min(...anchor.cells.map(([x]) => x)) +
              this.carryShift.column +
              this.carrySlide,
            row:
              Math.min(...anchor.cells.map(([, y]) => y)) +
              this.carryShift.row -
              this.carryDrop,
          }
        : null;
    // Rotating a PARKED piece: the dashed seat is the position the player
    // arranged, and the physical piece underneath may be in any orientation
    // — a re-grab after an undo anchors on the park, so the two must agree
    // or the next rotation visibly snaps the seat back. The piece is spun
    // to the park's orientation first (silent sync events, the undo log's
    // own path), then the player's rotation plays, and the park is redrawn
    // at the same corner in the resulting orientation. The O is a square:
    // every orientation is the same cells, nothing to sync. Non-rotating
    // keys and drags play as ever.
    const park = rotating && anchor === null && this.parked ? this.parked : null;
    // Pure geometry: how many CW taps spin the piece onto the park's
    // orientation. Zero for the O in any state (all four rotations are the
    // same cells), null when the piece is not the park's piece at all —
    // either way there is nothing to sync.
    const turns = park ? cwTurnsBetween(this.engine.falling.absoluteBlocks, park.cells) : null;
    // The turn is applied to the seat by hand below — the corner was read
    // above, the anchor re-derived after — so the plain key path must not
    // turn it a second time on its way through.
    this.seatByHand = true;
    try {
      if (turns) {
        for (let i = 0; i < turns; i++) {
          this.input("rotateCW", true);
          this.input("rotateCW", false);
        }
      }
      this.input(key, true);
      this.input(key, false);
    } finally {
      this.seatByHand = false;
    }
    // Everything queued above is ticked HERE — `input` only queues, so the
    // cells the park is redrawn from must be read after a flush or they are
    // the piece's pre-tap orientation. The stale read redrew the park at the
    // old orientation on the old corner (the teleport the finger saw), while
    // the piece itself ticked to a different orientation underneath.
    this.flushPending();
    if (turns !== null && park) {
      // The park is redrawn in the orientation the rotated piece now holds:
      // same corner as the seat showed, new cells. Dashed and unplaceable
      // as ever. (turns null — not the park's piece — redraws nothing: the
      // seat shows a piece that no longer exists, and no geometry speaks
      // for where its rotation should land.)
      const px = Math.min(...park.cells.map(([x]) => x));
      const py = Math.min(...park.cells.map(([, y]) => y));
      const nowCells = this.engine.falling.absoluteBlocks.map(([x, y]) => [x, y] as const);
      const dx = px - Math.min(...nowCells.map(([x]) => x));
      const dy = py - Math.min(...nowCells.map(([, y]) => y));
      this.parked = { cells: nowCells.map(([x, y]) => [x + dx, y + dy] as const) };
    }
    if (!corner) return;
    this.flushPending();
    if (this.phase !== "ready" && this.phase !== "playing") return;
    // The input nulled the carry; the rotated piece is the new anchor, and
    // the drop and slide are re-derived so the corner the player was
    // watching survives the rotation in place.
    const cells = this.engine.falling.absoluteBlocks.map(([x, y]) => [x, y] as const);
    this.carryBase = { cells };
    // The compensation solves for where the re-derived carry lands the seat
    // back on `corner` — with `carryShift` still applied by {@link carryAt}
    // itself, so it is subtracted here, not baked in twice.
    this.carryDrop =
      Math.min(...cells.map(([, y]) => y)) + this.carryShift.row - corner.row;
    this.carrySlide =
      corner.column - Math.min(...cells.map(([x]) => x)) - this.carryShift.column;
    // The preview re-derives from the same travel that produced it: the
    // shown seat survives the rotation, whatever orientation the piece now
    // holds. (A swipe's origin is shift-space, so it maps back through
    // whatever slide this re-derivation produced — no re-stamp needed.)
    this.carryAt({ ...this.carryShift });
  }

  /**
   * Where the piece would go if the pointer let go here.
   *
   * The engine is only ever asked through the planner, whose trials are
   * bracketed by `trialing`, so a preview can never move the real attempt.
   * Full spin support falls out of the planner: a square reachable only by a
   * kick is reachable, and the route replayed ends in the rotation that took
   * it there, so the engine credits the spin a player pressing keys would
   * have earned.
   */
  aimAt(spot: BoardSpot): void {
    if (this.phase !== "ready" && this.phase !== "playing") return;
    this.flushPending();
    // Flushing can itself end the attempt: the guard above ticked the log past
    // its frame ceiling, which finishes the run just as the loop would have.
    if (this.phase !== "ready" && this.phase !== "playing") return;
    // Rebuilt when the piece has moved under it, not only when a key was
    // pressed. `input()` fires once per physical press and drops the OS repeat,
    // but DAS and ARR keep shifting the piece every tick while a direction is
    // held — so a plan built before the shift would commit a route to a square
    // the piece has since left, and the drag would land somewhere the preview
    // never showed.
    const target = this.currentPlanner().targetAt(spot.column, spot.row, this.aim?.cells ?? null);
    this.aim = { cells: target, legal: this.searchPlacement(target) !== null };
    // The hollow is the contract — paint it now rather than whenever the next
    // frame happens to run, so a fast release cannot commit a square whose
    // preview was never shown.
    this.renderOnce();
  }

  /**
   * Drops the aimed piece exactly where the player can see it.
   *
   * The aim is the contract: the route committed is the one the preview
   * showed, found against the same board the attempt is on. A drag whose aim
   * was never accepted — one cut short by a lock, an undo or a restart —
   * commits nothing rather than guessing.
   *
   * The commit plays the route exactly as the trial did, as the timed batches
   * {@link ticksForRoute} builds: releases first, then the route's own ticks,
   * each ticked through the engine here and now. The events go in the log
   * with the same grouping, so the server replays the identical frames.
   * Playing it through `input` instead would retime it — a same-frame tap
   * holds nothing, so a mid-route soft drop would fall nowhere and every kick
   * after it would fire from the wrong height.
   */
  placeAt(): boolean {
    if (this.phase !== "ready" && this.phase !== "playing") return false;
    this.flushPending();
    // Flushing can itself end the attempt: the guard above ticked the log past
    // its frame ceiling, which finishes the run just as the loop would have.
    if (this.phase !== "ready" && this.phase !== "playing") return false;
    const aim = this.aim;
    this.aim = null;
    if (!aim || !aim.legal) return false;

    const placement = this.searchPlacement(aim.cells);
    if (!placement) return false;

    this.firstInputFrame ??= this.engine.frame;
    if (this.phase === "ready") this.begin();
    // The batches the route plays as: the releases first, then the route's
    // own ticks starting on the frame after. Built up front so the log and
    // the engine below stay on the same frames.
    const releases = releaseTicks(this.engine, this.engine.frame);
    const batches = [
      releases,
      ...ticksForRoute(
        placement.route,
        this.engine.frame + (releases.length > 0 ? 1 : 0),
        this.handling.sdf,
        placement.softDrops,
      ),
    ];
    // Held soft-drop frames arrive as eventless batches and are load-bearing:
    // the key must stay down while the clock walks, and the replay ticks every
    // frame whether or not it carries events. Nothing here filters empties.
    const additions = batches.reduce((total, batch) => total + batch.length, 0);
    // One rule from `input`, kept: a full log ends the attempt rather than
    // letting the player drive moves the server will never see.
    if (this.events.length + additions > MAX_EVENTS) {
      this.finish(this.solved() ? "solved" : "failed");
      return true;
    }
    // A slow soft drop spends real frames: its descent is held across as many
    // ticks as the handling needs, which can carry the log past the frame
    // ceiling the server enforces — and an event stamped there would have the
    // whole run rejected, not merely ended. The same honesty as the event
    // ceiling above: finish on what has been earned, commit nothing further.
    const lastBatch = batches[batches.length - 1];
    const lastFrame = lastBatch && lastBatch.length > 0 ? lastBatch[lastBatch.length - 1]!.frame : this.engine.frame;
    if (lastFrame > MAX_FRAMES) {
      this.finish(this.solved() ? "solved" : "failed");
      return true;
    }
    // Playing on after an undo is the player choosing this line over the one
    // they took back, so there is no longer a forward to redo into.
    this.undone = [];
    for (const batch of batches) {
      this.events.push(...batch);
      this.engine.tick(batch as never);
      // The hard drop ends the route, but a swallowed one (safe lock) or a
      // frame ceiling can end the attempt first — never drive the next piece
      // with the rest of this one.
      if (this.phase !== "playing" && this.phase !== "ready") break;
    }
    this.renderOnce();
    return true;
  }

  /**
   * The drag died without a release: drop everything it left behind.
   *
   * A contact the browser takes away — a second finger, a scroll, a lost
   * capture — decides nothing, and nothing it arranged may outlive it. The
   * anchor, the preview, the parked seat and any waiting rest gate all go. A
   * stale anchor used to hide the piece's landing shadow indefinitely and hand
   * the next rotation a seat that had been cancelled, and a surviving gate
   * filled its ring and then locked nothing.
   */
  cancelCarry(): void {
    this.endCarry();
    this.aim = null;
    this.parked = null;
    this.restGate = null;
    this.restRing = null;
    this.renderOnce();
  }

  // ── Drag carry ───────────────────────────────────────────────────────────

  /**
   * Takes hold of the piece where it is, without moving it.
   *
   * The carry model's anchor rule, now from the shadow: a drag starts from
   * the landing preview — where the piece would rest if it dropped now —
   * or from the seat a release parked it on when there is one. The tracker
   * measures the finger's travel and calls {@link carryAt} with the
   * amplified shift; this captures the base the shift applies to and moves
   * nothing.
   */
  grabBase(): void {
    this.flushPending();
    if (this.phase !== "ready" && this.phase !== "playing") return;
    // The carry anchors on the POSITION THE PLAYER SEES — never on the
    // piece's physical shadow, which is a seat the player arranged around
    // and may be nowhere near. Priority: a parked preview (a released
    // unplaceable seat, or the take-back an undo hands back), the seat a
    // rest gate is holding (the arranged position, still locking), the
    // drag's own dangling preview (the piece moved under a live aim — the
    // rotated-then-dragged report: without this the grab would jump the
    // preview back to the physical shadow), and only then the piece's
    // natural shadow. A still grab (carry 0,0) is deduped in {@link
    // carryAt}, so anchoring on the gate's own seat cannot cancel the
    // gate it anchored on; any real move or key still cancels it, as
    // everywhere else.
    const gateSeat = this.restGate?.cells ?? null;
    this.carryShift = { column: 0, row: 0 };
    if (this.parked) {
      this.carryBase = { cells: this.parked.cells };
      this.carryDrop = 0;
      this.carrySlide = 0;
      return;
    }
    if (gateSeat) {
      this.carryBase = { cells: gateSeat };
      this.carryDrop = 0;
      this.carrySlide = 0;
      return; // the gate keeps waiting: nothing about the seat changed
    }
    this.restGate = null;
    if (this.aim) {
      // The position on screen is the anchor. A shift of zero re-shows
      // the aim exactly — the drop and slide compensate for however far
      // the piece's physical cells sit from it (a key move or a rotation
      // happened under the dangling preview) — so the finger's travel
      // moves the piece FROM WHERE IT IS SHOWN, and the first square of
      // travel cannot teleport it anywhere.
      const aimCorner = {
        column: Math.min(...this.aim.cells.map(([x]) => x)),
        row: Math.min(...this.aim.cells.map(([, y]) => y)),
      };
      this.carryBase = {
        cells: this.engine.falling.absoluteBlocks.map(([x, y]) => [x, y] as const),
      };
      this.carryDrop =
        Math.min(...this.carryBase.cells.map(([, y]) => y)) - aimCorner.row;
      this.carrySlide =
        aimCorner.column - Math.min(...this.carryBase.cells.map(([x]) => x));
      return;
    }
    this.carryBase = {
      cells: this.engine.falling.absoluteBlocks.map(([x, y]) => [x, y] as const),
    };
    // Anchor where the piece would land, not where it hangs: the drop to
    // the shadow is remembered so the carried shift applies from there.
    let drop = 0;
    while (
      this.fallingFitsAt(this.carryBase.cells.map(([x, y]) => [x, y - (drop + 1)] as const))
    ) {
      drop++;
    }
    this.carryDrop = drop;
    this.carrySlide = 0;
  }

  /** Whether every one of `cells` is on the board and off the stack. */
  private fallingFitsAt(cells: readonly (readonly [number, number])[]): boolean {
    return (
      cells.every(([x]) => x >= 0 && x < BOARD_WIDTH) &&
      cells.every(([, y]) => y >= 0 && y < ENGINE_ROWS) &&
      cells.every(([x, y]) => !this.engine.board.occupied(x, y))
    );
  }

  /**
   * The piece's position while a drag carries it: `shift` is the finger's
   * travel from the grab point, already amplified in the tracker, measured
   * in board squares with no clamping — the travel is fully virtual, so an
   * excursion off the board and back lands the piece exactly where it was.
   *
   * On the board the preview shows the carried piece, legal or not; off it,
   * the preview drops (that is the reset the spec asks for) while the drag
   * stays live. The shift is applied to the base captured at the grab, so
   * the preview is exactly where the finger says — the piece underneath
   * keeps falling from its natural seat the whole time.
   */
  carryAt(shift: { column: number; row: number }): void {
    this.flushPending();
    if (!this.carryBase || (this.phase !== "ready" && this.phase !== "playing")) return;
    // The shift is measured from the shadow, not from the hang: the drop
    // the grab descended rides along, so the preview tracks the finger
    // relative to where the piece would land. The slide is the column part
    // of the same anchoring, fed by rotations taken mid-carry.
    const shifted = this.carryBase.cells.map(
      ([x, y]) => [x + shift.column + this.carrySlide, y + shift.row - this.carryDrop] as const,
    );
    // A move that re-derives the seat already showing is redundant — the
    // tracker emits one for every square the finger re-crosses — and must
    // not punch through the state resting on that seat: a re-grab during
    // the rest would otherwise cancel the very gate it anchored on. Tap's
    // re-derivation passes through unchanged: a rotated piece maps to
    // different squares, which is how the two cases stay apart.
    if (
      this.aim &&
      !this.parked &&
      this.aim.cells.length === shifted.length &&
      this.aim.cells.every(([x, y], index) => shifted[index]![0] === x && shifted[index]![1] === y)
    ) {
      this.carryShift = { column: shift.column, row: shift.row };
      return;
    }
    this.parked = null;
    this.restGate = null;
    this.carryShift = { column: shift.column, row: shift.row };
    const onBoard =
      shifted.every(([x]) => x >= 0 && x < BOARD_WIDTH) &&
      shifted.every(([, y]) => y >= 0 && y < ENGINE_ROWS);
    if (!onBoard) {
      // Fully virtual: the preview simply vanishes — a carried park included,
      // or a park would outlive its own drag's off-board release. Re-aiming
      // happens on the next in-bounds move; the drag never lost the thread.
      this.aim = null;
      this.parked = null;
      this.renderOnce();
      return;
    }
    const target = shifted as TargetCells;
    this.aim = { cells: target, legal: this.searchPlacement(target) !== null };
    this.renderOnce();
  }

  /**
   * The drag ended with the carried piece on the board.
   *
   * Nothing commits on the release itself: a placeable seat opens the lock
   * gate — the piece stays previewed while it waits out its rest — and an
   * unplaceable seat parks exactly as before, dashed over whatever it
   * overlaps, nothing spent. A released aim that is no longer live (a lock
   * or an undo got there first) does nothing at all.
   */
  settleAt(): void {
    const aim = this.aim;
    this.endCarry();
    if (!aim) {
      // Released off-board, or the drag was invalidated under the finger:
      // reset — the piece falls on as if untouched. The aim is already gone.
      this.renderOnce();
      return;
    }
    // A placeable seat is not spent yet: the gate opens and waits out the
    // rest. `placeAt` runs on the same {@link aim} when the rest completes —
    // the commit is the one the preview showed.
    if (aim.legal) {
      // The rest is measured from now, on the same clock the frame loop
      // and the rAF timestamps speak — stamped here, at the gate's open.
      this.restGate = { cells: aim.cells, restFor: performance.now() };
      // The gate is ticked by the clock, and the clock only runs once the
      // run has begun — a first placement released onto its seat must start
      // the run here, or it would wait out its rest forever.
      if (this.phase === "ready") this.begin();
      this.renderOnce();
      return;
    }
    // Not placeable: park exactly what was shown, as always.
    this.aim = null;
    this.parked = { cells: aim.cells };
    this.renderOnce();
  }

  /**
   * A clean downward flick: hard-drop the seat the stroke began on.
   *
   * The slam is ONE input command, not a drag plus a drop: its target is the
   * seat the piece was shown at when the stroke began — the same motion the
   * player made, descended to rest — never a seat the finger drifted to
   * afterwards. The origin arrives in the drag's own shift space and is
   * mapped through the anchor as it stands: mid-stroke taps re-derive the
   * carry without moving the shown seat, and the mapping rides along — the
   * drop takes the shown seat in whatever orientation it is shown.
   *
   * The seat is descended the way the keyboard's hard drop descends a piece —
   * one row at a time, while the row below is free — and then committed
   * through the same plan-and-lock path a release uses, without waiting out
   * the rest. A slam whose stroke seat sits off the board is INVALID: the
   * seat is where the piece would be shown, and off the board nothing is
   * shown — the gesture has no target, and the release resets the piece to
   * falling, exactly as a drag released off the board does. A seat buried
   * inside the stack has nothing to descend and stands as a park — the
   * arrangement is the player's, nothing spent. A rest gate
   * the slam answers goes with the carry: this commit IS that commit, made
   * now rather than waited out.
   */
  slamDrop(origin: BoardSpot): void {
    if (this.phase !== "ready" && this.phase !== "playing") return;
    // Without a live drag there is nothing to slam — an invalidated drag
    // commits nothing.
    if (!this.carryBase) {
      this.renderOnce();
      return;
    }
    // Read before the teardown below: it nulls the carry this reads.
    const base = this.carryBase;
    const slide = this.carrySlide;
    const drop = this.carryDrop;
    this.endCarry();
    this.parked = null;
    this.restGate = null;
    this.restRing = null;
    this.aim = null;
    let cells = base.cells.map(
      ([x, y]) => [x + origin.column + slide, y + origin.row - drop] as const,
    );
    // The stroke seat is where the piece would be shown. Off the board,
    // nothing IS shown: an invalid slam resets the piece, exactly as a
    // drag released off the board does — the piece falls on as if
    // untouched, and the swipe spends nothing.
    if (!this.fallingFitsAt(cells)) {
      this.renderOnce();
      return;
    }
    // Descend the stroke's seat until it rests: the hard drop the swipe
    // promised, made good. A seat buried in the stack has nothing to
    // descend, so the loop leaves it as it is.
    while (this.fallingFitsAt(cells.map(([x, y]) => [x, y - 1] as const))) {
      cells = cells.map(([x, y]) => [x, y - 1] as const);
    }
    // A seat buried inside the stack was ON the board: no reset, no spend
    // — the arrangement is the player's, parked where they left it.
    if (!this.fallingFitsAt(cells)) {
      this.parked = { cells: cells as TargetCells };
      this.renderOnce();
      return;
    }
    // `placeAt` re-searches the route against the real piece and validates
    // the seat itself; the synthetic aim only carries the target.
    this.aim = { cells: cells as TargetCells, legal: true };
    if (!this.placeAt()) this.renderOnce();
  }

  /**
   * The planner's answer, with the run's own listeners told to look away.
   *
   * Finding a placement trial-locks pieces on the real engine, and every one
   * of those locks would otherwise be counted against the puzzle — the
   * ledger spent, the undo boundary moved, the attempt even ended, all for
   * routes that are thrown away the moment they are scored.
   */
  private searchPlacement(cells: TargetCells) {
    this.trialing = true;
    try {
      return this.currentPlanner().placementAt(cells);
    } finally {
      this.trialing = false;
    }
  }

  /**
   * The plan for the piece as it is *now*, rebuilding it if the piece has moved.
   *
   * The one place a planner is obtained, because the aim and the commit have to
   * agree about which plan is current and they are separated by however long the
   * player holds their finger down.
   *
   * `input()` drops the plan on a key transition, which looks like enough. It is
   * not: it fires once per physical press and deliberately ignores the OS
   * repeat, while the engine's own DAS and ARR keep shifting the piece every
   * tick for as long as the key stays down. So the piece leaves the square the
   * plan was walked from with no input this class ever sees, and a commit
   * against that plan plays a route for a position the piece no longer holds —
   * the drag lands somewhere the preview never showed.
   */
  private currentPlanner(): RoutePlanner {
    if (!this.planner || !this.planner.matches(this.engine.falling)) {
      this.planner = new RoutePlanner(this.engine);
    }
    return this.planner;
  }

  // ── Clock ──────────────────────────────────────────────────────────────────

  /**
   * Feeds the engine everything recorded but not yet ticked.
   *
   * Planning must see the piece as the log now describes it: a rotation tapped
   * a moment ago sits in `pending` until the frame loop drains it, and an aim
   * computed before that would plan against the un-rotated piece. Every
   * pending event is stamped with the frame it was recorded on — the current
   * one, since only a tick advances the counter — so flushing here ticks
   * exactly the batch the loop would have ticked now, and the server replays
   * identical frames either way.
   */
  private flushPending(): void {
    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    this.engine.tick(batch as never);
    this.settleHoldBoundary();
    // The same guard the frame loop applies after its own ticks.
    if (this.engine.frame > MAX_FRAMES) this.finish("failed");
  }

  /**
   * Closes a swap's undo boundary, once the engine has actually made it.
   *
   * The engine has the last word on whether a hold went through — a queue with
   * nothing owed to trade is locked, whatever the ledger thought — and a
   * boundary recorded for a swap that never happened is an undo that takes
   * back nothing, which is the defect this boundary exists to avoid. Called
   * wherever the pending log is ticked, because that is when the trade, if it
   * was going to happen, has happened.
   */
  private settleHoldBoundary(): void {
    const pending = this.pendingHold;
    if (!pending) return;
    this.pendingHold = null;
    const swapped =
      this.engine.held !== pending.held ||
      toLetter(this.engine.falling.symbol) !== pending.falling;
    if (!swapped) return;
    this.checkpoints.push({
      length: this.events.length,
      frame: this.engine.frame,
      seat: [],
    });
  }

  private begin(): void {
    this.phase = "playing";
    this.lastTimestamp = performance.now();
    this.accumulator = 0;
    this.startLoop();
  }

  private startLoop(): void {
    if (this.rafHandle !== 0) return;
    const step = (timestamp: number) => {
      this.rafHandle = requestAnimationFrame(step);
      this.advance(timestamp);
      this.renderOnce();
    };
    this.rafHandle = requestAnimationFrame(step);
  }

  private stopLoop(): void {
    if (this.rafHandle !== 0) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = 0;
  }

  private advance(timestamp: number): void {
    if (this.phase !== "playing") return;
    this.accumulator += Math.min(MAX_CATCHUP_MS, timestamp - this.lastTimestamp);
    this.lastTimestamp = timestamp;

    while (this.accumulator >= FRAME_MS && this.phase === "playing") {
      this.accumulator -= FRAME_MS;
      const batch = this.pending;
      this.pending = [];
      this.engine.tick(batch as never);
      this.settleHoldBoundary();
      if (this.engine.frame > MAX_FRAMES) {
        this.finish("failed");
        return;
      }
    }

    this.tickRestGate(timestamp);
  }

  /**
   * The lock gate's rest, ticked by the clock the run already drives.
   *
   * A puzzle has no gravity — `lockTime` is beyond any run — so the only
   * thing that can ever lock a piece here is a commit, and the player's
   * hands are the only thing that can ask for one. The gate needs nothing
   * from the engine: it waits out its rest and commits through {@link
   * placeAt}, which plans, verifies and logs exactly as any drag commit
   * would. Anything that invalidates the seat — a re-grab, a key, an undo —
   * nulls the gate before this runs, so nothing is spent on a seat the
   * player walked away from; a seat the physics lost mid-rest is refused by
   * `placeAt` and ends the gate as a reset, not a misplacement. The ring
   * outlives the commit briefly, so the eye sees the promise kept — then
   * the placement's own animation takes over.
   */
  private tickRestGate(now: number): void {
    if (this.restRing && now - this.restRing.restFor >= RING_FADE_SECONDS * 1000) {
      this.restRing = null;
    }
    const gate = this.restGate;
    if (!gate) return;
    // A hand on the piece holds the wait open without advancing it: the rest is
    // time spent with the finger OFF the piece, and the last lift starts it
    // over (see {@link contactUp}). Without this the gate committed under a
    // still grab, and the gesture that followed — a tap meant for the piece
    // being held — landed on the piece after it.
    if (this.contactsDown > 0) return;
    if (now - gate.restFor >= REST_SECONDS * 1000) {
      this.restGate = null;
      if (this.phase === "ready" || this.phase === "playing") {
        // placeAt can end the attempt, and a duel restarts a failed one
        // SYNCHRONOUSLY inside it — so the run is re-read before the ring is
        // written, or a board that has just been rebuilt would wear the old
        // seat's ring as if the placement had happened on it.
        if (this.placeAt() && this.phase === "playing") {
          this.restRing = { cells: gate.cells, restFor: now };
        }
      }
    }
  }

  /** How far along the gate is: 0..1 while waiting, 1+ while the ring fades. */
  private restProgress(now: number): number | null {
    if (this.restGate) {
      // A hand on the piece holds the sweep at zero — the wait restarts when
      // the finger lifts, so showing it advancing under the finger would be a
      // promise the clock is not keeping — and the clock itself is clamped, so
      // a rest stamped a hair ahead of the frame reading it cannot run the ring
      // backwards.
      if (this.contactsDown > 0) return 0;
      return Math.max(0, Math.min(1, (now - this.restGate.restFor) / (REST_SECONDS * 1000)));
    }
    if (this.restRing) {
      return 1 + Math.min(1, (now - this.restRing.restFor) / (RING_FADE_SECONDS * 1000));
    }
    return null;
  }

  /**
   * Whether the attempt is over, after every lock.
   *
   * The attack target alone used to end it, and that is the bug this feature
   * exists for read from the other side: a puzzle asking for three TSDs is
   * worth twelve, and the run stopped at twelve however the player got there —
   * so the intended line was never the only line, and enforcing the clears on
   * the server without changing this would have ended the run *before* the
   * player could make the clear being demanded. Stricter scoring and an
   * unsolvable puzzle are the same edit unless both move together.
   *
   * So the run now continues past the attack target while a required clear is
   * still outstanding, and ends when the pieces run out.
   */
  private checkForEnd(): void {
    if (this.solved()) this.finish("solved");
    else if (this.ledger.remaining === 0) this.finish("failed");
  }

  /**
   * Whether the run has solved the puzzle — the only question five different
   * exits ask, and now the only place that answers it.
   *
   * A run that already solves as played is taken at its word and costs nothing.
   * One that does not is re-scored on its placements first, because the same
   * squares can be worth two different amounts depending on the kick that
   * reached them and the puzzle's target was derived from the better one. See
   * `credit.ts` for why that asymmetry existed and whom it punished.
   *
   * The re-score runs at most once per placement, and only on a run carrying a
   * T that cleared lines without being credited a T-spin — so an ordinary run
   * never pays for it. The credited totals replace the played ones outright:
   * the meter, the results card and the sheet the server is sent must all say
   * the same thing, and `creditPlacements` can only ever raise a score.
   *
   * This has to happen on the client at all, rather than being left to the
   * server, because a run the client calls failed is never submitted.
   */
  private solved(): boolean {
    if (solvesPuzzle(this.attack, this.clears, this.puzzle)) return true;
    if (this.credited) return false;
    this.credited = true;
    const credited = creditPlacements(this.setup, this.handling, this.placed);
    if (!credited) return false;
    this.placed = credited;
    this.attack = total(credited);
    this.clears = clearsOf(credited);
    return solvesPuzzle(this.attack, this.clears, this.puzzle);
  }

  private finish(phase: "solved" | "failed"): void {
    if (this.phase === "solved" || this.phase === "failed") return;
    this.phase = phase;
    this.finishedAt = Date.now();
    this.stopLoop();
    this.renderOnce();
    this.callbacks.onFinish(this.snapshot(), this.events);
  }

  // ── Reading state ──────────────────────────────────────────────────────────

  /** Squares the falling piece would occupy if hard-dropped right now. */
  private ghostCells(): (readonly [number, number])[] {
    const { falling, board } = this.engine;
    let drop = 0;
    for (;;) {
      const candidate = falling.absoluteAt({ y: falling.location[1] - (drop + 1) });
      if (candidate.some(([x, y]) => board.occupied(x, y))) break;
      drop++;
      if (drop > ENGINE_ROWS) break;
    }
    return falling.absoluteAt({ y: falling.location[1] - drop }).map(([x, y]) => [x, y] as const);
  }

  /** The held piece, but only when it is one the puzzle actually owes. */
  private heldPuzzlePiece(): Mino | null {
    const held = toLetter(this.engine.held);
    if (held === null || held === "G") return null;
    return this.ledger.owes(held) ? held : null;
  }

  snapshot(): RunSnapshot {
    const spent = this.piecesPlaced;
    // The engine's queue is padded so locking the last piece has something to
    // spawn; only the puzzle's own pieces are shown.
    const held = this.engine.held !== null;
    const realPiecesInQueue = Math.max(0, this.budget - spent - 1 - (held ? 1 : 0));
    const upcoming = this.engine.queue
      .raw()
      .map(toLetter)
      .filter((piece): piece is Mino => piece !== null && piece !== "G")
      .slice(0, realPiecesInQueue);


    return {
      phase: this.phase,
      attack: this.attack,
      targetAttack: this.puzzle.targetAttack,
      piecesPlaced: spent,
      pieceBudget: this.budget,
      clears: this.clears,
      elapsedMs: (this.finishedAt ?? Date.now()) - this.startedAt,
      resets: this.resets,
      // The engine's padding can end up in hold after the last real piece is
      // dealt out of it. It is not part of the puzzle, so it is not shown.
      hold: this.ledger.remaining > 0 ? this.heldPuzzlePiece() : null,
      upcoming,
      holdLocked: this.engine.holdLocked,
    };
  }

  view(): BoardView {
    const active = this.engine.falling;
    const stillPlaying = this.phase === "ready" || this.phase === "playing";
    const activeCells = stillPlaying
      ? active.absoluteBlocks.map(([x, y]) => [x, y] as const)
      : [];
    const now = performance.now();
    // The seat on screen, in the order of who owns it: a waiting rest gate
    // speaks for the seat it is holding, with its progress; a live drag or a
    // park is the piece the player is moving and outranks the ring a finished
    // commit is still fading — grabbing the next piece inside that fade used to
    // leave the preview undrawn with the old seat's ring on top of it. The ring
    // shows only while nothing live has taken the screen back.
    const gateProgress = stillPlaying && this.restGate ? this.restProgress(now) : null;
    const liveAim =
      !stillPlaying
        ? null
        : this.restGate
          ? { cells: this.restGate.cells, legal: true, progress: gateProgress! }
          : this.aim
            ? { cells: this.aim.cells, legal: this.aim.legal }
            : this.parked
              ? { cells: this.parked.cells, legal: false }
              : null;
    const ring = !liveAim && stillPlaying ? this.restProgress(now) : null;
    const ringCells = ring !== null ? (this.restRing?.cells ?? null) : null;
    return {
      cells: readBoard(this.engine) as readonly (readonly BoardCell[])[],
      visibleRows: this.visibleRows,
      active: activeCells,
      activeInk: stillPlaying ? (MINO_INK[toLetter(active.symbol) as Mino] ?? null) : null,
      // The carry surfaces have their own preview — the dragged aim, the
      // parked seat, the gate's wait — and while any of them is up it speaks
      // for the piece: the engine's own shadow would draw a second,
      // contradictory landing spot beside the one the player is steering,
      // both in the piece's ink. The shadow shows only when the piece speaks
      // with its natural voice.
      ghost:
        stillPlaying && !this.carryBase && !this.aim && !this.parked
          ? this.ghostCells()
          : [],
      flashRows: this.flashRows,
      flashStrength: Math.max(0, (this.flashUntil - now) / FLASH_MS),
      dimmed: this.phase === "failed",
      aim: liveAim ?? (ringCells && ring !== null ? { cells: ringCells, legal: true, progress: ring } : null),
    };
  }

  renderOnce(): void {
    this.callbacks.onFrame(this.view(), this.snapshot());
  }
}
