"""
archive_commands.py
~~~~~~~~~~~~~~~~~~~
`/archive sync` — pull the club's spreadsheet into the puzzle database.

A group rather than `/puzzle sync`, and that is worth recording because it is
the second time the decision has been made. Discord will not let one name be
both invocable and a group, so `/puzzle` becoming a parent would rename the
command everybody already types — the command that also announces each new
version to a server. `puzzle_commands.py` collapsed four subcommands into one
for that reason, and `/report` is top-level for the same one. `/archive` is a
name nobody types today, so it costs nothing and leaves room for the siblings
this will want later: a status, and one day a publish.

**Only the safe half of the sync.** `bun run sync-archive` reads the sheet and
upserts every puzzle it can replay, and everything it writes lands
*unpublished* — the review gate. It is re-runnable, and it is what
`activity/DEPLOY.md` blesses. The two neighbouring tools are deliberately not
reachable from Discord: `publish-archive` changes which puzzle every future day
deals, and `bun run puzzles` has already caused a boot failure by dropping a
puzzle a rush pool referenced. Those stay decisions somebody makes at a
terminal with the guide open.

Environment (see example.env):
    PUZZLE_ACTIVITY_DIR   Where the activity checkout lives. Defaults to the
                          `activity/` beside this repository, which is right
                          whenever the bot and the activity are deployed from
                          one tree, as they are on the club's box.
"""

import asyncio
import os
import sys
from pathlib import Path

import discord
from discord import app_commands

import puzzle_admins

#: The activity half of this repository, where `bun run sync-archive` lives.
#:
#: Set explicitly as the subprocess's working directory, not merely assumed:
#: Bun reads `.env` from the process working directory only and does not walk
#: up, so a sync started from the repository root would run with none of
#: `activity/.env` loaded.
DEFAULT_ACTIVITY_DIR = Path(__file__).resolve().parent.parent / "activity"

#: Long enough for a cold run over the whole sheet, short enough that a wedged
#: sync gives the officer an answer rather than a spinner. A local dry run over
#: 163 puzzles takes a few seconds; the ceiling is for a slow network and a
#: database the live server is holding, which `sync-archive` waits out with its
#: own `busy_timeout`.
SYNC_TIMEOUT_S = 300

#: Discord's own ceiling is 2000 characters. The reply spends the rest on the
#: framing around the tool's output.
MAX_OUTPUT_CHARS = 1500

#: `sync-archive` distinguishes its exits, and treating any non-zero as failure
#: would report the tool's expected work as a fault. 1 means rows it could not
#: write, which is the sync not doing its job; 2 means content edits landed,
#: which is normal but is the one thing somebody has to go and read.
EXIT_OK = 0
EXIT_UNWRITTEN = 1
EXIT_EDITED = 2

#: One sync at a time, in this process.
#:
#: `sync-archive` is re-runnable and takes a `busy_timeout` against the live
#: server, so a second run would not corrupt anything — it would do the same
#: work twice and report two half-truths to two officers. Refusing is kinder
#: than surviving.
_running = asyncio.Lock()


def _activity_dir() -> Path:
    override = os.environ.get("PUZZLE_ACTIVITY_DIR", "").strip()
    return Path(override) if override else DEFAULT_ACTIVITY_DIR


#: Enough to stop a fence closing, invisible to a reader.
#:
#: Discord looks for the next ``` anywhere in the message, not only at the
#: start of a line, so three backticks inside the tool's output would close the
#: block the reply opened and render everything after it as markdown. The
#: output carries puzzle titles straight from the club's spreadsheet
#: (`sync-archive.ts` prints `#42 "the title"`), which is text this bot does
#: not control.
FENCE = "```"
DEFANGED_FENCE = "`\u200b`\u200b`"


def _fence_safe(text: str) -> str:
    return text.replace(FENCE, DEFANGED_FENCE)


def _clip(text: str, limit: int = MAX_OUTPUT_CHARS) -> str:
    """
    The tail of the tool's output, which is where its summary lives.

    The head is the part to lose: `describe()` prints the counts and then a
    line per puzzle, so a long run's interesting end — the skipped rows, the
    "nothing was written" note — is exactly what head-truncation would cut.
    """
    body = text.strip()
    if len(body) <= limit:
        return body
    return "…\n" + body[-limit:].lstrip()


async def run_sync(dry_run: bool, by: str, cwd: Path | None = None) -> tuple[int, str]:
    """
    Runs `bun run sync-archive` and returns its exit code and combined output.

    Separated from the command callback so the interesting half is testable
    without a Discord interaction, and so the callback reads as policy rather
    than as process handling.

    `--by` is an attribution rather than an identity — `sync-archive` says so
    itself — and it lands in the gitignored working database, never in the
    tracked archive. It is worth passing because a content edit found months
    later with no explanation is a small mystery, and "who ran the sync" is the
    answer to it.
    """
    directory = cwd or _activity_dir()
    argv = ["bun", "run", "sync-archive"]
    if dry_run:
        argv.append("--dry-run")
    argv += ["--by", by]

    # Checked before the exec, because `create_subprocess_exec` raises
    # FileNotFoundError for a missing `bun` *and* for a missing cwd, and the
    # two want opposite advice. Telling an officer to install Bun when the real
    # problem is an unset PUZZLE_ACTIVITY_DIR sends them a long way wrong.
    if not directory.is_dir():
        return -1, (
            f"`{directory}` is not there, so the sync has nowhere to run. "
            "Point PUZZLE_ACTIVITY_DIR at the activity checkout."
        )

    try:
        process = await asyncio.create_subprocess_exec(
            *argv,
            cwd=str(directory),
            stdout=asyncio.subprocess.PIPE,
            # Merged rather than kept apart: the tool interleaves its warnings
            # with its report, and two streams shown separately in a Discord
            # message would put a warning about a puzzle a screen away from the
            # line about that puzzle.
            stderr=asyncio.subprocess.STDOUT,
        )
    except FileNotFoundError:
        return -1, (
            "`bun` is not on this bot's PATH, so the sync cannot run here. "
            "It has to be installed for the user the bot runs as."
        )
    except OSError as exc:
        return -1, f"Could not start the sync: {exc}"

    try:
        stdout, _ = await asyncio.wait_for(process.communicate(), timeout=SYNC_TIMEOUT_S)
    except asyncio.TimeoutError:
        # Killed rather than left behind: an abandoned sync still holds a write
        # transaction against the database the live server is reading.
        process.kill()
        await process.wait()
        return -1, (
            f"The sync ran past {SYNC_TIMEOUT_S}s and was stopped. Nothing is "
            "half-written — it writes in one transaction."
        )

    return process.returncode or 0, stdout.decode("utf-8", errors="replace")


def verdict(code: int, dry_run: bool) -> str:
    """
    The sentence under the output. Public, so it says what to do next.

    Every branch checks `dry_run`, because a dry run that says "Synced" is a
    lie about the one thing the option exists to promise. Only the clean branch
    used to, which made `verdict(2, dry_run=True)` claim puzzles had changed
    content when nothing had been written at all.

    Exit 1 does **not** say the sheet was read. `sync-archive.ts` invokes
    `main()` as a bare top-level await with no catch, so an uncaught throw —
    the sheet answering an HTML sign-in page because it stopped being shared, a
    renamed tab, a network failure — exits 1 exactly like the rows-would-not-
    write case it documents. The two are indistinguishable from out here, so
    the wording covers both and sends somebody to the output above it rather
    than asserting a successful read. The narrower sentence belongs in the tool,
    behind a distinct exit code.
    """
    if code == EXIT_OK:
        return "Sheet read, nothing left over." if dry_run else "Synced."
    if code == EXIT_EDITED:
        if dry_run:
            return (
                "Nothing was written. Some puzzles would change content — the lines "
                "above are worth reading before anybody syncs for real."
            )
        return (
            "Synced, and some puzzles changed content — the lines above are worth "
            "reading before anybody publishes."
        )
    if code == EXIT_UNWRITTEN:
        return (
            "It stopped short — either some rows would not write, or the sync failed "
            "outright. The output above says which, and this needs a look at a "
            "terminal."
        )
    return "The sync failed."


archive = app_commands.Group(
    name="archive",
    description="Officer tools for the puzzle archive.",
)


@archive.command(
    name="sync",
    description="Pull the club's spreadsheet into the puzzle archive.",
)
@app_commands.describe(
    dry_run="Read the sheet and report what would change, writing nothing.",
)
async def archive_sync(
    interaction: discord.Interaction, dry_run: bool = False
) -> None:
    # The refusal answers before any defer, which is this repository's rule and
    # not a style choice: deferring ephemerally would make every later followup
    # ephemeral too, and deferring publicly posts a visible "thinking" for a
    # command about to be turned away. The allowlist is one small file read, so
    # there is nothing to wait on yet.
    #
    # Private, because it is about the person rather than about the world. An
    # officer-only command answering "you are not an officer" in the channel is
    # a scolding with an audience.
    user = getattr(interaction, "user", None)
    if not puzzle_admins.is_admin(getattr(user, "id", None)):
        await interaction.response.send_message(
            "That one is for officers. If it should be you, an officer can add your "
            f"Discord id to `{puzzle_admins.ADMINS_PATH.name}` — "
            f"`{puzzle_admins.EXAMPLE_PATH.name}` in the repository shows the shape, "
            "and it takes effect on the next command with no restart.",
            ephemeral=True,
            allowed_mentions=discord.AllowedMentions.none(),
        )
        return

    if _running.locked():
        # Public: a sync already running is a fact about the world, and the
        # officer watching their own reply should see this one too.
        await interaction.response.send_message(
            "A sync is already running. Give it a moment and try again.",
            allowed_mentions=discord.AllowedMentions.none(),
        )
        return

    async with _running:
        # Public from here on. The result is a change to the club's archive,
        # and an officer running it silently is how two people run it twice.
        await interaction.response.defer()
        label = (
            getattr(user, "name", None)
            or getattr(user, "display_name", None)
            or "discord"
        )
        code, output = await run_sync(dry_run=dry_run, by=f"discord:{label}")

    heading = "**Dry run** — nothing was written.\n" if dry_run else ""
    body = _fence_safe(_clip(output))
    try:
        await interaction.followup.send(
            f"{heading}```\n{body}\n```\n{verdict(code, dry_run)}",
            # The two sibling command modules both pass this on every send, and
            # this one carries text from the spreadsheet, so it needs it most:
            # an @everyone in a puzzle title would otherwise ping the server.
            allowed_mentions=discord.AllowedMentions.none(),
        )
    except Exception as exc:  # noqa: BLE001 — the reply is best-effort
        # The sync itself already happened. Losing the message must not look
        # like losing the work, so this is logged rather than raised into
        # discord.py's handler, which would show the officer a generic failure
        # for a command that succeeded.
        print(f"archive-sync: could not post the result ({exc})", file=sys.stderr)
