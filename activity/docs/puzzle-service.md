# The puzzle service

Where puzzle data lives, who may read it, and what has to stay true while it moves.

This is a plan, not a description of what is built. Sections marked **now** are
true today; sections marked **planned** are not built yet.

---

## Why this document exists

There are three copies of the puzzle archive, and they disagree:

| Copy | Rows | Owner |
|---|---|---|
| the Google Sheet | 200 metadata rows, 151 with blueprint codes | the club, edited by hand in Blueprint |
| `activity/data/puzzles.json` (+ `solutions.json`) | 138 | this repository, committed |
| `var/data/puzzles.json` in the website repo | 140 | that repository, committed |

The two committed copies were cut from the sheet at different times and neither
is refreshed by anything automatic. Every new puzzle currently has to be
imported twice, by hand, into two repositories that decode it differently.

**Measured 2026-09-06** by running the existing build against the live sheet
(`bun run tools/build-puzzles.ts --archive <fetched> --out <scratch>`):

- **148 puzzles build**, against 138 committed — so **10 are new**, not the 62
  the row count suggests. The `Puzzles` tab has 200 rows but only 151 carry a
  blueprint code pair; the rest are metadata without a puzzle behind them yet.
- **3 fail to build and are skipped**, as they should be: #13 and #149 have a
  step the router cannot reach, and #58's answer sends no attack, so there is
  nothing to score against.
- **136 of 148 stated goals match the replayed clears.** The other twelve
  disagree, which is what the frozen clear requirement exists to absorb.
- **12 already-published puzzles have changed content since the last build.**
  That is the finding that matters most, and it has its own rule below.

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
138 puzzles to 148 changes which puzzle every future day draws.

Tomorrow's puzzle changes the moment the pool grows, so the pool should grow
**once**, deliberately, rather than a few rows at a time.

### 4b. A puzzle id does not identify a puzzle

`day_puzzles` pins a day to a `puzzle_id` and nothing else:

    CREATE TABLE IF NOT EXISTS day_puzzles (
      day       INTEGER NOT NULL,
      tier      TEXT NOT NULL,
      puzzle_id INTEGER NOT NULL,
      PRIMARY KEY (day, tier)
    );

There is no content snapshot. So the pin survives a *reordering* of the pool,
which is what it was built for — and does **not** survive the content behind an
id changing. Rebuilding from the sheet today changes twelve published puzzles:

- **#8 is a different puzzle now.** Board, queue, goal and title all changed;
  it went from "fourtris mogs" to "misplaced heart". Whoever played day-N
  puzzle 8 played something that no longer exists under that id, and their
  score is now filed against a puzzle they never saw.
- **#7 and #109 have different piece queues** — same length, different pieces.
  They play differently, so old scores are not comparable to new ones.
- The remaining nine are harmless: eight difficulty ratings (five of them
  filling in a 0 that meant "unrated") and one title typo on #3.

This has to be decided before the first sync, not discovered after it. The
options are to let the content move and accept that a few historical rows now
describe a different puzzle, or to treat content as immutable once published
and give a changed puzzle a new id. **Nothing should sync until somebody
chooses**, because the second option is much harder to apply retroactively.

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

0. **Decide what a changed puzzle means** (rule 4b). Blocks everything else.
1. **Schema and sync.** `archive_puzzles` table; `tools/sync-archive.ts`
   pulling both tabs over `gviz`, decoding and replaying exactly as
   `build-puzzles.ts` does, upserting rows as unpublished. Seeded from the
   existing 138 so the table starts equal to what is live.

   Two details the build already has and the sync must keep: it reads its own
   previous output to **carry frozen clear requirements forward** (112 of 138
   carry across today), and it reads sheet columns **by position**, so a column
   inserted in either tab shifts every field silently. The sync should match on
   header names instead.
2. **Public read endpoints.** `GET /api/archive`, `GET /api/archive/:id`,
   solutions included. No key.
3. **The activity reads the table.** `PuzzleArchive.load` sources from the
   database, with the committed JSON as the seed. Run endpoints unchanged.
4. **Retire the duplicates.** `activity/data/solutions.json`, and the website's
   `var/data/puzzles.json` seed, once the website consumes the endpoint.

Publishing the 62 new puzzles is a step of its own, taken deliberately, after
1–3 are in and reviewed. See rule 4.

---

## Open questions for the club

- **`hide answer`** is a real column on the `blueprint urls` tab. Nobody has
  said what it means for the public endpoint. The decision that solutions are
  safe to publish was made about the archive as a whole; this column looks like
  a per-puzzle intent that predates it, and it should be honoured or explicitly
  retired rather than ignored.
- **Rule 4b** — whether a published puzzle's content may change under its id.

## Naming

The database already has `puzzle_solutions`, which holds *discovered alternate*
solutions found by players — a different thing entirely from an author's
answer. The new table is `archive_puzzles`, and the author's answer is a column
on it. Nothing here reuses the word `solutions` on its own.
