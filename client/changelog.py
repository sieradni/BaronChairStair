"""
changelog.py
~~~~~~~~~~~~
What the bot is, what version it is, and what changed since a server last heard.

Split from the commands for the same reason `report_text.py` is: it is data and
string building with no Discord in it, so it can be tested with bare `python3`
on a box that has none of the bot's dependencies installed.

The one rule everything here follows: **a server is told about every version it
has not been told about**, not just the newest one. Production pulls whenever
somebody deploys, which may be several versions after the last deploy, and a
changelog that only ever described the tip would silently skip the middle.
"""

from __future__ import annotations

import sqlite3
import time
from dataclasses import dataclass


@dataclass(frozen=True)
class Release:
    """One version, and what a player would notice about it."""

    version: str
    #: Short, player-facing lines. Not commit subjects — what changed for them.
    changes: tuple[str, ...]


#: Newest first. Order in this tuple *is* the version order, deliberately:
#: comparing "beta 0.10" against "beta 0.9" as text is wrong and as numbers is a
#: parser nobody needs. Adding a release means putting it at the top.
#:
#: Keep `changes` to things a player can see. "Refactored the planner" is not a
#: change to announce; "the drag lands where the preview showed" is.
RELEASES: tuple[Release, ...] = (
    Release(
        version="beta 0.1",
        changes=(
            "Puzzles can now require the clears their goal names — a goal that says "
            "\"2 TSDs\" is no longer satisfied by any line that reaches the attack target.",
            "Your progress toward those clears shows on the board while you play.",
            "Solved a daily? **Play again** replays it unscored, so your filed run stands.",
            "The **Solved!** stamp now clears itself once there is a solution to read.",
            "`/report` files in the channel and allows 15 reports an hour instead of 3.",
        ),
    ),
)

#: What this build is. Read by `/puzzle` and by whatever announces a deploy.
VERSION: str = RELEASES[0].version

#: How many releases one message will spell out in full.
#:
#: A server that has never heard from the bot has "not been told" about every
#: version there has ever been, and reading the project's whole history is not
#: what somebody typing `/puzzle` asked for. Past this, the message says how
#: many older ones it is not listing.
MAX_RELEASES_IN_MESSAGE = 3


def releases_since(seen: str | None) -> tuple[Release, ...]:
    """
    Every release newer than `seen`, newest first.

    `None` — a server that has never been told anything — means all of them, and
    so does a version this build has never heard of. That second case is a
    downgrade or a hand-edited row, and announcing too much is the safe way to
    be wrong: the alternative is a server that silently never hears again.
    """
    if seen is None:
        return RELEASES
    for index, release in enumerate(RELEASES):
        if release.version == seen:
            return RELEASES[:index]
    return RELEASES


def is_current(seen: str | None) -> bool:
    """Whether a server has already been told about this build."""
    return seen == VERSION


def format_announcement(releases: tuple[Release, ...]) -> str:
    """
    The message a server gets, or `""` when there is nothing to say.

    Deliberately plain text and no embed: this rides along behind the puzzle
    announcement, which *is* an embed, and two in a row reads as two things to
    deal with rather than one thing and a footnote.
    """
    if not releases:
        return ""

    shown = releases[:MAX_RELEASES_IN_MESSAGE]
    hidden = len(releases) - len(shown)

    if len(releases) == 1:
        opening = f"**Puzzle bot {shown[0].version}**"
    else:
        opening = (
            f"**Puzzle bot {releases[0].version}** — "
            f"{len(releases)} updates since this server last heard"
        )

    lines = [opening, ""]
    for release in shown:
        # The version headed only when there is more than one, so the ordinary
        # single-release case reads as a list of changes rather than a form.
        if len(shown) > 1:
            lines.append(f"__{release.version}__")
        lines.extend(f"• {change}" for change in release.changes)
        lines.append("")
    if hidden > 0:
        lines.append(f"_…and {hidden} earlier {'update' if hidden == 1 else 'updates'}._")

    return "\n".join(lines).strip()


# ── What each server has already been told ───────────────────────────────────
#
# Per guild rather than per process. Two servers can first run `/puzzle` days
# apart, and the one that has been quiet must still hear about the versions it
# slept through rather than only the newest.


def init_db(db: sqlite3.Connection) -> None:
    """Creates the table. Called once at boot, like `puzzle_recap.init_db`."""
    db.execute("""
        CREATE TABLE IF NOT EXISTS bot_versions (
            guild_id     INTEGER PRIMARY KEY,
            version      TEXT    NOT NULL,
            announced_at REAL    NOT NULL
        )
    """)
    db.commit()


def seen_version(db: sqlite3.Connection, guild_id: int) -> str | None:
    """The last version this server was told about, or None if never."""
    row = db.execute(
        "SELECT version FROM bot_versions WHERE guild_id = ?", (guild_id,)).fetchone()
    return None if row is None else str(row[0])


def claim_announcement(
    db: sqlite3.Connection, guild_id: int, version: str = VERSION
) -> tuple[bool, str | None]:
    """
    Takes the right to announce `version` to one server, once.

    Returns ``(claimed, previously_seen)``. `claimed` is false when this server
    has already been told — including when a concurrent `/puzzle` won the race a
    moment ago.

    Claimed *before* the send and not after, for the reason `puzzle_recap.claim`
    gives: the write is what excludes the second caller, so it has to happen
    where two callers can still both be running. The cost is that a send failing
    after the claim loses that announcement, which is the right way round — a
    changelog posted twice is worse than one posted never, and the next release
    will say what this one would have.

    The `WHERE` is the whole exclusion. Two calls read the same `previously_seen`
    and both try the write; exactly one changes a row.
    """
    previously = seen_version(db, guild_id)
    if previously == version:
        return False, previously
    cursor = db.execute(
        "INSERT INTO bot_versions (guild_id, version, announced_at) VALUES (?, ?, ?) "
        "ON CONFLICT(guild_id) DO UPDATE SET version = excluded.version, "
        "announced_at = excluded.announced_at "
        "WHERE bot_versions.version IS NOT excluded.version",
        (guild_id, version, time.time()))
    db.commit()
    return cursor.rowcount == 1, previously


def announcement_for(
    db: sqlite3.Connection, guild_id: int, version: str = VERSION
) -> str:
    """
    The message this server should see now, or `""` if it should see nothing.

    Claims as it goes, so calling it twice announces once.
    """
    claimed, previously = claim_announcement(db, guild_id, version)
    if not claimed:
        return ""
    return format_announcement(releases_since(previously))
