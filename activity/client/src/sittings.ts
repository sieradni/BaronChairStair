/**
 * How long each of the day's puzzles has been open, and how many restarts it
 * has taken.
 *
 * This is the leaderboard's sort key. `runs.total_ms` is what the daily board
 * orders by, and it comes from the client: the server only sees a daily run
 * when it *solves*, so nothing on the server knows a player spent ten minutes
 * on a puzzle before walking away.
 *
 * It used to be a `Map` field on the app. That carried the clock across
 * restarts, which is the case `PuzzleRun`'s own constructor comment describes —
 * "the time that matters is time spent on the puzzle, not on one attempt" — and
 * across detours into practice, which `app.ts` calls out as "a free place at
 * the top of a leaderboard sorted by time".
 *
 * It did not survive the panel closing. A Discord activity is closed and
 * reopened constantly, and every reopen built a new app with an empty `Map`, so
 * the clock started again from zero. A player who struggled for ten minutes,
 * closed the panel and came back to solve it in thirty seconds was filed at
 * thirty seconds — ahead of everyone who had simply stayed. Reported by a
 * player, not caught here.
 *
 * So it lives where `started.ts` lives and for the reason that file already
 * gives: scoped per player, because one origin serves every Discord account
 * that has opened the activity in this browser, and stamped with the day, so
 * yesterday's clock is never read as today's and there is nothing to clean up.
 *
 * **What this does not do** is make the clock unfakeable. A player who clears
 * site data still gets a fresh one, exactly as they always could, because the
 * elapsed time on a daily is client-reported by design — the server bounds it
 * below by the verified replay and no further. Closing the panel is the
 * accident this fixes; deliberate tampering needs the server to hold the
 * anchor, which is a larger change than a bug report warrants.
 */

const VERSION = 1;

function storageKey(playerId: string): string {
  return `puzzle.sittings.v${VERSION}.${playerId}`;
}

/** One puzzle's clock and restart tally. */
export interface Sitting {
  /** When the player first saw this puzzle today. */
  readonly openedAt: number;
  /** Restarts carried over from earlier attempts at it. */
  readonly resets: number;
}

interface Stored {
  readonly day: number;
  readonly sittings: Readonly<Record<string, Sitting>>;
}

export interface Sittings {
  /** This puzzle's sitting, starting one at `now` if it has none. */
  open(day: number, puzzleId: number, now?: number): Sitting;
  /** Records the tally after an attempt. Keeps whatever `openedAt` it had. */
  record(day: number, puzzleId: number, resets: number): void;
  /**
   * Forgets one, so a replay or a fresh look starts its own clock.
   *
   * Takes the day for the same reason `open` and `record` do: it has to read
   * storage before it can remove anything. Without that it could only forget a
   * sitting this app instance had already touched — and the replay path runs
   * before any of them, so after the panel was reopened it removed nothing and
   * the replay inherited the filed run's clock and restart tally.
   */
  forget(day: number, puzzleId: number): void;
}

function read(key: string, day: number): Record<string, Sitting> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const stored = JSON.parse(raw) as Partial<Stored>;
    // A record from another day is not this day's, exactly as in `started.ts`:
    // reading it as empty is the whole of the rollover.
    if (stored.day !== day || typeof stored.sittings !== "object" || stored.sittings === null) {
      return {};
    }
    const out: Record<string, Sitting> = {};
    for (const [id, value] of Object.entries(stored.sittings)) {
      const openedAt = (value as Partial<Sitting>)?.openedAt;
      const resets = (value as Partial<Sitting>)?.resets;
      // A clock in the future would hand out negative elapsed time, which sorts
      // first on a board ordered ascending. Anything unreadable is dropped
      // rather than repaired.
      if (typeof openedAt !== "number" || !Number.isFinite(openedAt)) continue;
      out[id] = {
        openedAt,
        resets: typeof resets === "number" && Number.isFinite(resets) ? resets : 0,
      };
    }
    return out;
  } catch {
    // Private-mode browsers and blocked storage land here. The clock then
    // behaves exactly as it did before this file existed.
    return {};
  }
}

function write(key: string, stored: Stored): void {
  try {
    localStorage.setItem(key, JSON.stringify(stored));
  } catch {
    // The in-memory copy still answers for the rest of this session.
  }
}

export function createSittings(playerId: string): Sittings {
  const key = storageKey(playerId);
  let today: { day: number; sittings: Record<string, Sitting> } | null = null;

  function state(day: number): { day: number; sittings: Record<string, Sitting> } {
    if (today?.day !== day) today = { day, sittings: read(key, day) };
    return today;
  }

  function save(day: number): void {
    write(key, { day, sittings: state(day).sittings });
  }

  return {
    open(day, puzzleId, now = Date.now()) {
      const current = state(day);
      const existing = current.sittings[String(puzzleId)];
      // Never move an existing clock forward. This is the whole point of the
      // file: reopening the panel must not restart it.
      if (existing) return existing;
      const fresh: Sitting = { openedAt: now, resets: 0 };
      current.sittings[String(puzzleId)] = fresh;
      save(day);
      return fresh;
    },
    record(day, puzzleId, resets) {
      const current = state(day);
      const existing = current.sittings[String(puzzleId)];
      if (!existing) return;
      if (existing.resets === resets) return;
      current.sittings[String(puzzleId)] = { openedAt: existing.openedAt, resets };
      save(day);
    },
    forget(day, puzzleId) {
      const current = state(day);
      if (!(String(puzzleId) in current.sittings)) return;
      delete current.sittings[String(puzzleId)];
      save(day);
    },
  };
}
