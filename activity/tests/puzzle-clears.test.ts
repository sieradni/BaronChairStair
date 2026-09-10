/**
 * Which puzzles a player has ever solved.
 *
 * `runs` cannot answer this and was never meant to: it is keyed
 * `(day, player_id, slot)`, so it knows what happened on a *day*. A player who
 * solves the same puzzle again next month in practice overwrites nothing and
 * adds nothing — and practice never reached the server at all.
 *
 * This is what unlocks a puzzle's solutions gallery and ticks the Explore list,
 * so the two things that matter are that every path records it and that nothing
 * silently loses a first solve.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/db";

const DB = join(tmpdir(), `puzzle-clears-${process.pid}.sqlite`);
const wipe = () => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(DB + suffix, { force: true });
};

let store: Store;

beforeEach(() => {
  wipe();
  store = new Store(DB);
  store.upsertPlayer({ id: "ada", username: "Ada", avatarUrl: null });
});

afterEach(() => {
  store.close();
  wipe();
});

describe("recording a clear", () => {
  test("a puzzle nobody has solved is not cleared", () => {
    expect(store.hasCleared("ada", 93)).toBe(false);
    expect(store.clearedPuzzleIds("ada").size).toBe(0);
  });

  test("solving it once is enough, forever", () => {
    store.recordClear({ playerId: "ada", puzzleId: 93, durationMs: 9_000 });
    expect(store.hasCleared("ada", 93)).toBe(true);
    expect([...store.clearedPuzzleIds("ada")]).toEqual([93]);
  });

  test("solving it again keeps the first time and takes the better one", () => {
    // "When did you first crack this" is the fact worth keeping, and a plain
    // upsert would move it every time somebody replayed a favourite.
    store.recordClear({ playerId: "ada", puzzleId: 93, durationMs: 9_000 });
    // Backdated, because both calls otherwise land in the same millisecond and
    // a `first_at` that moved would be invisible — which is exactly what this
    // test is for.
    const first = 1_000;
    store.archiveReader.run("UPDATE puzzle_clears SET first_at = ?1, last_at = ?1", [first]);

    store.recordClear({ playerId: "ada", puzzleId: 93, durationMs: 4_000 });
    const row = store.archiveReader
      .query<{ first_at: number; last_at: number; times: number; best_ms: number }, []>(
        "SELECT first_at, last_at, times, best_ms FROM puzzle_clears",
      )
      .get()!;

    expect(row.first_at).toBe(first);
    // And `last_at` did move, so the row is genuinely being updated rather than
    // the whole statement quietly doing nothing.
    expect(row.last_at).toBeGreaterThan(first);
    expect(row.times).toBe(2);
    expect(row.best_ms).toBe(4_000);
  });

  test("a slower re-solve does not spoil the best time", () => {
    store.recordClear({ playerId: "ada", puzzleId: 93, durationMs: 4_000 });
    store.recordClear({ playerId: "ada", puzzleId: 93, durationMs: 30_000 });
    expect(
      store.archiveReader.query<{ best_ms: number }, []>("SELECT best_ms FROM puzzle_clears").get()!
        .best_ms,
    ).toBe(4_000);
  });

  test("an untimed solve never wins the best time", () => {
    // A legacy row carries `total_ms = 0`. Letting a zero win would put an
    // unbeatable 0:00.0 on a profile forever.
    store.recordClear({ playerId: "ada", puzzleId: 93, durationMs: 5_000 });
    store.recordClear({ playerId: "ada", puzzleId: 93, durationMs: 0 });
    expect(
      store.archiveReader.query<{ best_ms: number }, []>("SELECT best_ms FROM puzzle_clears").get()!
        .best_ms,
    ).toBe(5_000);
  });

  test("clears are per player", () => {
    store.upsertPlayer({ id: "bo", username: "Bo", avatarUrl: null });
    store.recordClear({ playerId: "ada", puzzleId: 93, durationMs: 1_000 });
    expect(store.hasCleared("bo", 93)).toBe(false);
  });
});

describe("the daily history already on file", () => {
  /** A database with solved daily runs and no clears table use yet. */
  function seedRuns(): void {
    const db = new Database(DB, { create: true });
    db.run(
      `INSERT INTO runs (day, player_id, guild_id, puzzle_id, solved, attack, target_attack,
                         duration_ms, total_ms, resets, pieces_placed, clears, created_at, slot)
       VALUES (10,'ada',NULL,93,1,4,4,500,9000,0,4,'[]',1000,'easy'),
              (11,'ada',NULL,93,1,4,4,500,4000,0,4,'[]',2000,'easy'),
              (12,'ada',NULL,94,1,4,4,500,   0,0,4,'[]',3000,'hard'),
              (13,'ada',NULL,95,0,1,4,500,7000,0,4,'[]',4000,'easy')`,
    );
    db.close();
  }

  test("becomes clears on the next boot", () => {
    seedRuns();
    store.close();
    store = new Store(DB);

    // #93 twice on two days is one puzzle; #95 was never solved.
    expect([...store.clearedPuzzleIds("ada")].sort((a, b) => a - b)).toEqual([93, 94]);
  });

  test("the same puzzle on two days is one clear, timed by the better day", () => {
    seedRuns();
    store.close();
    store = new Store(DB);

    const row = store.archiveReader
      .query<{ times: number; best_ms: number }, [number]>(
        "SELECT times, best_ms FROM puzzle_clears WHERE puzzle_id = ?1",
      )
      .get(93)!;
    expect(row.times).toBe(2);
    expect(row.best_ms).toBe(4_000);
  });

  test("a day with no recorded time comes through untimed rather than at zero", () => {
    seedRuns();
    store.close();
    store = new Store(DB);

    expect(
      store.archiveReader
        .query<{ best_ms: number }, [number]>(
          "SELECT best_ms FROM puzzle_clears WHERE puzzle_id = ?1",
        )
        .get(94)!.best_ms,
    ).toBe(0);
  });

  test("the backfill is a no-op on every boot after the first", () => {
    // It must never overwrite a `first_at` that a real solve has since improved
    // on, nor inflate `times` by re-counting the same rows.
    seedRuns();
    store.close();
    new Store(DB).close();
    store = new Store(DB);

    expect(
      store.archiveReader
        .query<{ times: number }, [number]>("SELECT times FROM puzzle_clears WHERE puzzle_id = ?1")
        .get(93)!.times,
    ).toBe(2);
  });
});

describe("the profile", () => {
  test("counts distinct puzzles, and solves, and tells them apart", () => {
    store.recordClear({ playerId: "ada", puzzleId: 93, durationMs: 1_000 });
    store.recordClear({ playerId: "ada", puzzleId: 93, durationMs: 2_000 });
    store.recordClear({ playerId: "ada", puzzleId: 94, durationMs: 3_000 });

    const p = store.profile("ada");
    expect(p.puzzlesCleared).toBe(2);
    expect(p.clearsTotal).toBe(3);
    // Best time per puzzle, summed: 1000 + 3000.
    expect(p.bestMsTotal).toBe(4_000);
  });

  test("a player who has done nothing reads as zero rather than throwing", () => {
    expect(store.profile("nobody")).toEqual({
      puzzlesCleared: 0,
      clearsTotal: 0,
      bestMsTotal: 0,
      rushSolved: 0,
      rushRuns: 0,
      bestRush: 0,
      discoveries: 0,
    });
  });
});

describe("the archive board", () => {
  test("ranks by how much of the archive somebody has solved", () => {
    store.upsertPlayer({ id: "bo", username: "Bo", avatarUrl: null });
    for (const id of [1, 2, 3]) store.recordClear({ playerId: "ada", puzzleId: id, durationMs: 1 });
    store.recordClear({ playerId: "bo", puzzleId: 1, durationMs: 1 });

    expect(store.clearsBoard().map((r) => [r.player.id, r.cleared])).toEqual([
      ["ada", 3],
      ["bo", 1],
    ]);
  });

  test("a tie goes to whoever got there first", () => {
    // The only ordering that does not shuffle under people as new players
    // arrive: reaching forty last month is ahead of reaching forty today.
    store.upsertPlayer({ id: "bo", username: "Bo", avatarUrl: null });
    store.recordClear({ playerId: "ada", puzzleId: 1, durationMs: 1 });
    store.recordClear({ playerId: "bo", puzzleId: 1, durationMs: 1 });
    store.archiveReader.run("UPDATE puzzle_clears SET first_at = 10 WHERE player_id = 'bo'");
    store.archiveReader.run("UPDATE puzzle_clears SET first_at = 20 WHERE player_id = 'ada'");

    expect(store.clearsBoard().map((r) => r.player.id)).toEqual(["bo", "ada"]);
  });

  test("it counts puzzles, not solves", () => {
    // Somebody who replays a favourite twenty times has solved one puzzle.
    for (let n = 0; n < 20; n++) {
      store.recordClear({ playerId: "ada", puzzleId: 7, durationMs: 1 });
    }
    expect(store.clearsBoard()[0]!.cleared).toBe(1);
  });

  test("a player nobody has a row for still resolves by name", () => {
    expect(store.playerNamed("ada")?.username).toBe("Ada");
    expect(store.playerNamed("nobody")).toBeNull();
  });
});

describe("how today landed", () => {
  /** A day's worth of filed runs, across two players and three tiers. */
  function seedDay(): void {
    store.upsertPlayer({ id: "bo", username: "Bo", avatarUrl: null });
    const db = store.archiveReader;
    const row = (player: string, slot: string, solved: number, ms: number) =>
      db.run(
        `INSERT INTO runs (day, player_id, guild_id, puzzle_id, solved, attack, target_attack,
                           duration_ms, total_ms, resets, pieces_placed, clears, created_at, slot)
         VALUES (5, ?1, 'g1', 1, ?2, 4, 4, 500, ?3, 0, 4, '[]', 1, ?4)`,
        [player, solved, ms, slot],
      );
    row("ada", "easy", 1, 5_000);
    row("ada", "medium", 0, 9_000);
    row("bo", "easy", 1, 3_000);
    row("bo", "hard", 1, 7_000);
  }

  test("counts hand-ins and solves per tier, and zeroes the untouched", () => {
    seedDay();
    const tiers = store.dailyTierStats(5, "g1");
    expect(tiers.easy).toEqual({ filed: 2, solved: 2 });
    expect(tiers.medium).toEqual({ filed: 1, solved: 0 });
    expect(tiers.hard).toEqual({ filed: 1, solved: 1 });
    // Nobody opened it: zeroes rather than a missing key the page has to guess at.
    expect(tiers.extreme).toEqual({ filed: 0, solved: 0 });
  });

  test("a standing is ordered the way the board it is a rank in is ordered", () => {
    // Bo solved two in 10s; Ada solved one in 5s. Solved first, then time.
    seedDay();
    expect(store.dayStanding(5, "g1", "bo")).toEqual({
      rank: 1, of: 2, solved: 2, totalMs: 10_000,
    });
    expect(store.dayStanding(5, "g1", "ada")?.rank).toBe(2);
  });

  test("the field is everybody who filed, not everybody who solved", () => {
    seedDay();
    expect(store.dayStanding(5, "g1", "ada")?.of).toBe(2);
  });

  test("somebody who filed nothing has no rank at all", () => {
    seedDay();
    expect(store.dayStanding(5, "g1", "nobody")).toBeNull();
  });

  test("a guild sees its own day; no guild sees everybody", () => {
    seedDay();
    expect(store.dailyTierStats(5, "g2").easy.filed).toBe(0);
    expect(store.dailyTierStats(5, null).easy.filed).toBe(2);
  });
});

describe("the daily records", () => {
  /** Solved days for one player, newest day last. */
  function solvedOn(player: string, days: readonly number[], perDay = 1): void {
    const db = store.archiveReader;
    const tiers = ["easy", "medium", "hard", "extreme"];
    for (const day of days) {
      for (let i = 0; i < perDay; i++) {
        db.run(
          `INSERT INTO runs (day, player_id, guild_id, puzzle_id, solved, attack, target_attack,
                             duration_ms, total_ms, resets, pieces_placed, clears, created_at, slot)
           VALUES (?1, ?2, 'g1', 1, 1, 4, 4, 500, 1000, 0, 4, '[]', 1, ?3)`,
          [day, player, tiers[i]!],
        );
      }
    }
  }

  test("solves count every tier; days count the day once", () => {
    // A day holds four puzzles. Solving three of them is three solves and one
    // day, and the two boards mean different things.
    solvedOn("ada", [10], 3);
    const [row] = store.dailyRecords(10);
    expect(row!.solves).toBe(3);
    expect(row!.days).toBe(1);
  });

  test("a streak runs back from today", () => {
    solvedOn("ada", [8, 9, 10]);
    expect(store.dailyRecords(10)[0]!.current).toBe(3);
  });

  test("today not yet played does not break it", () => {
    // The rule `Store.streak` uses, copied deliberately: a player who solved
    // yesterday and has not opened today still has their streak.
    solvedOn("ada", [8, 9]);
    expect(store.dailyRecords(10)[0]!.current).toBe(2);
  });

  test("but a missed day does", () => {
    solvedOn("ada", [5, 6, 9]);
    expect(store.dailyRecords(10)[0]!.current).toBe(1);
  });

  test("the best streak is the longest run they ever put together", () => {
    // 1..4 is four; the recent 9..10 is two. Best is the old one.
    solvedOn("ada", [1, 2, 3, 4, 9, 10]);
    const [row] = store.dailyRecords(10);
    expect(row!.best).toBe(4);
    expect(row!.current).toBe(2);
  });

  test("and it agrees with the per-player streak the profile shows", () => {
    // If these differ, the number on somebody's profile and the number ranking
    // them on a board disagree — which nobody reports and everybody notices.
    solvedOn("ada", [6, 7, 8, 9, 10]);
    expect(store.dailyRecords(10)[0]!.current).toBe(store.streak("ada", 10));
  });

  test("a player who solved nothing is not in it at all", () => {
    solvedOn("ada", [10]);
    store.upsertPlayer({ id: "bo", username: "Bo", avatarUrl: null });
    expect(store.dailyRecords(10).map((r) => r.player.id)).toEqual(["ada"]);
  });
});
