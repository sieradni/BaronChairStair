# Working in this repository

**This file does not contain deploy instructions. It tells you where they are, and
carries the few rules that live nowhere else.**

That split is deliberate. An earlier version of this file restated the deploy
sequences and got the activity's build order backwards, which would have shipped an
unverified client bundle to players. Two documents describing the same procedure will
drift, and the copy loaded into every session is the one that drifts unnoticed.

## Read the real guide before deploying

| | Lives in | Its guide |
|---|---|---|
| **The Discord bot** | repository root, `client/` | [`DEPLOY.md`](DEPLOY.md) |
| **The activity** (the puzzle itself) | `activity/` | [`activity/DEPLOY.md`](activity/DEPLOY.md) |

Two projects, separate deploys, different `.env` files. Follow the guide for the half
you are touching, in the order it gives — the order is load-bearing in both.

Where this file and a guide differ, **do the stricter thing and say so in your report.**
Do not treat either as licence to skip a step the other requires.

## The one thing the guides cannot tell you, because it is about you

**When a check goes red, stop and report. Do not restart through it.** That is this
project's own precedent and it has caught real bugs. A check that is red on a box where
CI was green usually means the box differs from CI in a way worth understanding.

Two exceptions worth knowing so you do not stop on a healthy deploy:

- `bun test` in `activity/` reports **around 83 skips** on a box without
  `data/solutions.json`, which is gitignored and not in git. Skips are expected;
  `0 fail` is the thing to check.
- A bot suite run with a bare `python3` skips or stubs anything needing `discord.py`.
  Use the interpreter that actually runs the bot.

## Client-side changes need a build, and fail silently without one

`activity/dist/` is gitignored, so `git pull` never updates it and the server serves
whatever bundle is on the box (`activity/server/config.ts` → `clientBuild: ../dist`).
A pull and a restart give you the new server and the old client, with no error anywhere:
the page loads, nothing throws, and the behaviour is simply the old one.

This applies to everything under `activity/client/` — both the game (`client/src/`)
and the officer review tool (`client/review/`), which build together.

`activity/DEPLOY.md` has the sequence and the verification steps, including how to tell
whether a *specific* change reached the bundle. Use them; a restart is not a deploy.

## Decisions that are not yours to make

Report these and stop; do not act on them unasked.

- **`bun run puzzles`** rebuilds `data/puzzles.json` from the club's spreadsheet.
  `activity/DEPLOY.md` forbids running it before the backfill, and it has caused a boot
  failure by dropping a puzzle a rush pool referenced.
- **`bun run publish-archive`** makes synced puzzles playable, which changes which puzzle
  every future day deals. (`bun run sync-archive` is safe and re-runnable by contrast —
  everything it writes lands unpublished, and that is the review gate.) Both live in
  `activity/`, not the root.
- **`GOAL_ENFORCEMENT`.** Controls whether clear requirements are shown and enforced.
  Check what the box actually sets (`grep -E '^GOAL_ENFORCEMENT=' activity/.env`) rather
  than assuming; it defaults to `log`, which shows and enforces nothing. Turning it `on`
  needs the current bundle deployed first, or players are judged against a requirement
  their client never showed them.
- **Rotating a secret**, or anything that signs users out.

## Never

- **Commit `activity/data/daily.sqlite`, or its `-wal`/`-shm`.** This repository is
  **public** and that file holds real Discord ids, usernames, run history and
  submissions. It is gitignored; keep it so. `VACUUM INTO` compacts it faithfully and
  redacts *nothing* — a backup tool, not an export. The only database that may be tracked
  is `activity/data/archive/puzzles.sqlite`, built fresh by the sync and never having
  held a player table; `activity/tests/tracked-archive.test.ts` asserts that.
- **`pkill -f` on a broad pattern.** `pkill -f "server/index.ts"` matches more than you
  mean and has already taken down the wrong server. Kill by exact PID.
- **Leave two bot processes running.** Two instances on one token double-handle every
  command, which presents as the bot answering everything twice. Stop the old one before
  starting the new one — `DEPLOY.md` has the commands for finding how it runs.
- **Assume `.env` is loaded.** Bun reads `.env` from the process working directory only;
  it does not look beside the entrypoint and does not walk up.

## Couplings that are easy to miss

- `PUZZLE_API_KEY` in the root `.env` must match `BOT_API_KEY` in `activity/.env` —
  **different names on either side.** A mismatch is a 401, an unset key a 404, and the
  daily recap simply never posts.
- A new slash command needs a restart to appear, and a global sync can take an hour.
  `sync_guilds.py <SERVER_ID>` pushes it to one guild at once — then
  `sync_guilds.py --clear <SERVER_ID>` once the global ones land, or the picker shows
  every command twice.

## Further reading

- `README.md`, `activity/README.md` — what the commands *are*, as opposed to how to run them.
- `activity/docs/puzzle-service.md` — the puzzle data layer. **A design plan, not a
  description of the running system**; sections are marked *now* or *planned*, and its
  numbered rules are the things most easily broken by accident.
