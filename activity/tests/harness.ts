/**
 * The hand-turned clock and frame loop the run-driving suites share.
 *
 * A run advances on animation frames, which do not exist headlessly — so the
 * suites install a clock they control and pump the run's own loop by hand.
 * One copy: every suite that drives a run imports this instead of mocking
 * the globals itself.
 */

export const FRAME_MS = 1000 / 60;
/** Enough frames for anything grounded to lock, and then some. */
export const PATIENCE = 300;
/**
 * The engine swallows a hard drop for a few frames after a piece locks, so a
 * key still down at the lock cannot slam the next piece. A real player's next
 * press lands after that window — and so do the suites that pump these frames
 * before reading the board or handing the log to the verifier.
 */
export const SAFE_LOCK_FRAMES = 8;

let clock = 0;
let scheduled: FrameRequestCallback | null = null;

const realPerformance = globalThis.performance;

function install(): void {
  globalThis.performance = { now: () => clock } as unknown as Performance;
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
    scheduled = callback;
    return 1;
  };
  globalThis.cancelAnimationFrame = () => {
    scheduled = null;
  };
}

install();

/**
 * Hands the globals back.
 *
 * Process-wide, so a suite that calls it affects every suite after it — which
 * is why {@link resetHarness} re-installs rather than trusting the import-time
 * call. Kept for the one suite that genuinely wants the real clock back.
 */
export function restoreClock(): void {
  globalThis.performance = realPerformance;
}

/**
 * Forgets the loop state between tests, and puts the clock back.
 *
 * Re-installing matters and is not belt-and-braces. The clock is installed once
 * at import, but `restoreClock` hands `performance` back **process-wide** — so
 * once any suite calls it in an `afterAll`, every suite that runs afterwards
 * gets the real clock, and `pump` silently stops advancing anything. The
 * failure is not an error: frames simply do not happen, and a test that waits
 * for something to move waits forever or, worse, asserts against a board that
 * never changed and passes for the wrong reason.
 *
 * Every suite already calls this in `beforeEach`, so making it the one place
 * the clock is guaranteed puts each suite back in charge of its own frames
 * regardless of what ran before it.
 */
export function resetHarness(): void {
  install();
  clock = 0;
  scheduled = null;
}

/** Runs the run's own loop for `count` frames, one engine tick each. */
export function pump(count: number): void {
  for (let index = 0; index < count; index++) {
    const step = scheduled;
    if (!step) return;
    clock += FRAME_MS;
    step(clock);
  }
}

/** Runs the loop until `done`, so a test never has to guess a lock delay. */
export function pumpUntil(done: () => boolean): void {
  for (let index = 0; index < PATIENCE && !done(); index++) pump(1);
}
