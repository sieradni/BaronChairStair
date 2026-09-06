# The puzzle service

Where puzzle data lives, who may read it, and what has to stay true while it moves.

This is a plan, not a description of what is built. Sections marked **now** are
true today; sections marked **planned** are not built yet.

---

## Why this document exists

There are three copies of the puzzle archive, and they disagree:

| Copy | Rows | Owner |
|---|---|---|
| the Google Sheet | 200 | the club, edited by hand in Blueprint |
| `activity/data/puzzles.json` (+ `solutions.json`) | 138 | this repository, committed |
| `var/data/puzzles.json` in the website repo | 140 | that repository, committed |

Sixty-two puzzles exist that `/puzzle` has never served. The two committed
copies were cut from the sheet at different times and neither is refreshed by
anything automatic. Every new puzzle currently has to be imported twice, by
hand, into two repositories that decode it differently.

The fix is one service that owns the archive, and two consumers that read it.

**The service lives here, in BaronChairStair.** The production VPS already runs
this repository's activity server; that is the machine with the database, the
Tetris engine, and the deploy story. Standing up a second service in the
website repository would mean a second deploy, a second database and a second
copy of the engine to verify puzzles with.

---

## What "the service" actually is — **planned**

**It is the activity server.** Not a new process.

That server already has the three things a puzzle service needs, and they are
not cheap to reproduce:

- a SQLite database with a migration path (`activity/server/db.ts`),
- an HTTP layer (Hono) already deployed and fronted on the VPS,
- the real TETR.IO engine, which is the only thing that can tell you what a
  puzzle's answer actually *sends*.

A separate process for two hundred rows would add a deploy, a port and a
failure mode, and buy nothing. What changes is where the archive is read
from, not how many programs are running.

## Data flow — **now** vs **planned**

**Now.** A maintainer downloads two tabs of the sheet as CSV into `../tmp`,
runs `bun run puzzles`, and commits the result:

    Sheet ──manual CSV──▶ tools/build-puzzles.ts ──▶ data/puzzles.json
                                (decode + replay)     data/solutions.json
                                                            │ committed
                                                            ▼
                                                  PuzzleArchive.load  (boot)

**Planned.** The same decode-and-replay step, run against the sheet directly,
writing rows instead of files:

    Sheet ──gviz CSV──▶ tools/sync-archive.ts ──▶ archive_puzzles  (pending)
                          (decode + replay)             │
                                              review UI │ publishes
                                                        ▼
                                              PuzzleArchive.load  (boot)
                                                        │
                                        ┌───────────────┴───────────────┐
                                        ▼                               ▼
                                 the game                     GET /api/archive
                             (withholds answers)            (public, includes
                                                              answers)

`gviz/tq?tqx=out:csv&sheet=<tab>` exports a public sheet tab as CSV with no
credentials, which is what removes the manual download step. Measured
2026-09-06: both tabs return HTTP 200 and 201 lines — a header and 200
puzzles.

---

## The rules this must not break

These are the things that are load-bearing today. Each one has bitten this
project or is one edit away from doing so.

### 1. The game still withholds the answer

Storing solutions publicly and showing them to a player mid-run are different
questions. The club's position is that the answers are already public
elsewhere, so the *service* may serve them — `GET /api/archive` includes the
solution, and the website may render it.

**The run endpoints must not.** A player part-way through today's puzzle must
not be able to fetch the answer from the server that is scoring them.

This is already enforced by the type system, and that is the mechanism to keep:

    export type PuzzlePrompt = Omit<Puzzle, "solution" | "source">;

`Puzzle` carries the answer; `PuzzlePrompt` is the same thing with the answer
and the provenance removed, and it is what the player-facing routes send. The
compiler — not a reviewer's memory — is what stops an answer reaching a player.
Add the archive endpoints as routes that serve `Puzzle`, and leave every
existing route serving `PuzzlePrompt`. Do not "unify" the two types; that
inconsistency is the safety property.

### 2. Every puzzle is engine-verified before it is playable

`tools/build-puzzles.ts` does something irreplaceable: it replays the author's
answer through the real engine to learn what it actually sends, and that number
becomes the puzzle's target. A puzzle whose answer will not replay is skipped,
because a puzzle with no verified target is one nobody can be scored against.

The sync must do exactly this, and must refuse to publish a puzzle that fails
it. A row that reaches the pool unverified is a puzzle that cannot be beaten.

### 3. Something still reviews new puzzles before players see them

Today the review gate is git: a new puzzle arrives as a diff in a tracked JSON
file and a human approves the pull request. A database write has no such gate,
and adding 62 puzzles to the live pool without one is the main risk in this
whole plan.

The replacement: **sync writes rows unpublished**, and the existing review UI
publishes them. Sync is a command somebody runs, not a timer — a cron job that
silently changes what the club plays tomorrow is the thing to avoid.

### 4. Growing the pool reshuffles every future day

The daily rotation is a pure function of the pool's *length*
(`puzzleIndexForDay(day, pool.length, stream)`, `shared/daily.ts`). Going from
138 puzzles to 200 changes which puzzle every future day draws.

Past days are safe: `day_puzzles` pins what was actually served, so history and
old leaderboards do not move. But tomorrow's puzzle changes the moment the pool
grows, and the pool should therefore grow **once**, deliberately, rather than a
few rows at a time.

### 5. `PuzzleArchive.load` runs once, at module scope

`activity/server/index.ts:113`. The pool a process serves is the pool it booted
with, and several modules document that they depend on this. Reading the
archive from the database does not change that and must not: a pool that can
change under a running server means a player's run can be scored against a
different puzzle than it started on. **New rows become playable on restart.**

### 6. Dev may read production, but must never write it

Pointing the dev bot at the production archive is the point of the exercise —
one dataset, not two. Reads only. The public read endpoints need no key, which
makes this easy; nothing else about dev should reach production.

---

## Order of work — **planned**

1. **Schema and sync.** `archive_puzzles` table; `tools/sync-archive.ts`
   pulling both tabs over `gviz`, decoding and replaying exactly as
   `build-puzzles.ts` does, upserting rows as unpublished. Seeded from the
   existing 138 so the table starts equal to what is live.
2. **Public read endpoints.** `GET /api/archive`, `GET /api/archive/:id`,
   solutions included. No key.
3. **The activity reads the table.** `PuzzleArchive.load` sources from the
   database, with the committed JSON as the seed. Run endpoints unchanged.
4. **Retire the duplicates.** `activity/data/solutions.json`, and the website's
   `var/data/puzzles.json` seed, once the website consumes the endpoint.

Publishing the 62 new puzzles is a step of its own, taken deliberately, after
1–3 are in and reviewed. See rule 4.

---

## Naming

The database already has `puzzle_solutions`, which holds *discovered alternate*
solutions found by players — a different thing entirely from an author's
answer. The new table is `archive_puzzles`, and the author's answer is a column
on it. Nothing here reuses the word `solutions` on its own.
