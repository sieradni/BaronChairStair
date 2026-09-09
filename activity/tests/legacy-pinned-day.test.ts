/**
 * A day pinned before `extreme` existed.
 *
 * Every row already in `day_puzzles` names easy, medium and hard only, and those
 * days are history: the puzzles they name were played and scored. `pinnedDay`
 * demands the full set, so it answers null for them and the day is topped up
 * rather than left short.
 *
 * The hazard is what the fourth puzzle is. The old `hard` band ran from eight
 * upwards and the new `extreme` band from nine, so a puzzle pinned as a day's
 * hard can sit in today's extreme pool — and deriving blind hands the same
 * puzzle to the player twice on one day. That is the case this file pins.
 *
 * The three puzzles already on file must not move either. They are what the
 * leaderboard rows for that day were scored against.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/db";
import { DaySchedule, pastDaysOf } from "../server/schedule";
import { PuzzleArchive } from "../server/puzzles";
import { byTier, DAILY_TIERS } from "../shared/daily";

const PUZZLES = "data/puzzles.json";

describe("topping up a day pinned before the fourth tier", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "legacy-pin-"));
    path = join(dir, "t.sqlite");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** Writes a three-tier day straight into the table, as the old code would have. */
  function pinLegacy(day: number, ids: { easy: number; medium: number; hard: number }): void {
    const db = new Database(path, { create: true });
    const store = new Store(path);
    store.close();
    for (const [tier, id] of Object.entries(ids)) {
      db.run("INSERT OR IGNORE INTO day_puzzles (day, tier, puzzle_id) VALUES (?1, ?2, ?3)", [
        day, tier, id,
      ]);
    }
    db.close();
  }

  const opened = () => {
    const archive = PuzzleArchive.load(PUZZLES, {}, [], []);
    const store = new Store(path, pastDaysOf(archive));
    return { archive, store, schedule: new DaySchedule(archive, store) };
  };

  test("keeps the three puzzles the day was played with", () => {
    const first = opened();
    const day = first.archive.currentDay() - 1;
    const was = {
      easy: first.schedule.forTier(day, "easy").id,
      medium: first.schedule.forTier(day, "medium").id,
      hard: first.schedule.forTier(day, "hard").id,
    };
    first.store.close();
    rmSync(path, { force: true });
    pinLegacy(day, was);

    const after = opened();
    try {
      expect(after.schedule.forTier(day, "easy").id).toBe(was.easy);
      expect(after.schedule.forTier(day, "medium").id).toBe(was.medium);
      expect(after.schedule.forTier(day, "hard").id).toBe(was.hard);
    } finally {
      after.store.close();
    }
  });

  test("never deals the same puzzle twice on one day", () => {
    // The collision, forced: pin as `hard` the very puzzle the extreme rotation
    // would hand this day. Blind derivation would then deal it in both slots.
    const probe = opened();
    const day = probe.archive.currentDay() - 1;
    const clash = probe.schedule.forTier(day, "extreme").id;
    const easy = probe.schedule.forTier(day, "easy").id;
    const medium = probe.schedule.forTier(day, "medium").id;
    probe.store.close();
    rmSync(path, { force: true });
    pinLegacy(day, { easy, medium, hard: clash });

    const after = opened();
    try {
      const dealt = DAILY_TIERS.map((tier) => after.schedule.forTier(day, tier).id);

      expect(new Set(dealt).size).toBe(dealt.length);
      expect(after.schedule.forTier(day, "hard").id).toBe(clash);
      expect(after.schedule.forTier(day, "extreme").id).not.toBe(clash);
    } finally {
      after.store.close();
    }
  });

  test("the substitute still comes from the right tier", () => {
    const probe = opened();
    const day = probe.archive.currentDay() - 1;
    const clash = probe.schedule.forTier(day, "extreme").id;
    const easy = probe.schedule.forTier(day, "easy").id;
    const medium = probe.schedule.forTier(day, "medium").id;
    probe.store.close();
    rmSync(path, { force: true });
    pinLegacy(day, { easy, medium, hard: clash });

    const after = opened();
    try {
      const chosen = after.schedule.forTier(day, "extreme");
      const pool = byTier(after.archive.all).extreme.map((puzzle) => puzzle.id);

      expect(pool).toContain(chosen.id);
    } finally {
      after.store.close();
    }
  });
});
