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

The notes themselves are **not** in this file. They live in `changelog.json` at
the repository root. That was so the activity could show them too; that card was
removed, and the file stayed where it is — one list, in one place, and nothing
to keep in step with a second copy.
"""

from __future__ import annotations

import json
import sqlite3
import sys
import time
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Release:
    """One version, and what a player would notice about it."""

    version: str
    #: Short, player-facing lines. Not commit subjects — what changed for them.
    changes: tuple[str, ...]


#: Where the notes live. Beside this file's *project*, not beside this file:
#: `client/` is half of a repository the activity shares.
CHANGELOG_PATH = Path(__file__).resolve().parent.parent / "changelog.json"


def load_releases(path: Path = CHANGELOG_PATH) -> tuple[Release, ...]:
    """
    Reads the notes off disk, newest first.

    Order in the file *is* the version order, deliberately: comparing
    "beta 0.10" against "beta 0.9" as text is wrong and as numbers is a parser
    nobody needs. Adding a release means putting it at the top of the file.

    Keep `changes` to things a player can see. "Refactored the planner" is not a
    change to announce; "the drag lands where the preview showed" is.

    **Never raises.** A missing or malformed file means no announcements, said
    on stderr, and the bot starts anyway. `discord_bot.py` imports this module
    at top level and not inside a `try`, so raising here would take the whole
    bot down over a changelog — which is the one feature in the repository that
    breaks nothing when it is absent.
    """
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        entries = raw["releases"]
    except (OSError, ValueError, KeyError, TypeError) as exc:
        print(f"changelog: cannot read {path} ({exc}); announcements are off",
              file=sys.stderr)
        return ()

    releases: list[Release] = []
    for entry in entries:
        try:
            version = str(entry["version"])
            changes = tuple(str(line) for line in entry["changes"])
        except (KeyError, TypeError) as exc:
            print(f"changelog: skipping a malformed release in {path} ({exc})",
                  file=sys.stderr)
            continue
        releases.append(Release(version=version, changes=changes))
    return tuple(releases)


#: Newest first. Read once, at import, like the rest of this module's data.
RELEASES: tuple[Release, ...] = load_releases()

#: What this build is. Read by `/puzzle` and by whatever announces a deploy.
#:
#: `"unknown"` only when the notes could not be read at all, which
#: `load_releases` has already said on stderr. Nothing announces under that name
#: — `announcement_for` refuses before it claims — so it never reaches a channel
#: and never lands in `bot_versions` to be compared against later.
VERSION: str = RELEASES[0].version if RELEASES else "unknown"

#: How many releases one message will spell out in full.
#:
#: A server that has never heard from the bot has "not been told" about every
#: version there has ever been, and reading the project's whole history is not
#: what somebody typing `/puzzle` asked for. Past this, the message says how
#: many older ones it is not listing.
MAX_RELEASES_IN_MESSAGE = 3

#: The ceiling a Discord message actually has, less room to be wrong about it.
#:
#: Counting releases is not counting characters. Three releases of eight wordy
#: notes measured 2,029 characters, which Discord rejects with a 400 — and since
#: the claim is taken before the send, a rejected message is one a server never
#: hears, not one it hears late. So the message is trimmed by length as well as
#: by release count, and says what it dropped.
MAX_MESSAGE_CHARS = 1900


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

    # Longest first, then shorter, until one fits. Trimming a rendered string
    # would cut mid-sentence or mid-release; dropping whole releases and
    # re-rendering keeps every message a well-formed one that says what it left
    # out. At worst this is one release, which is why the last line is a plain
    # truncation rather than another retry.
    for count in range(min(MAX_RELEASES_IN_MESSAGE, len(releases)), 0, -1):
        text = _render(releases, count)
        if len(text) <= MAX_MESSAGE_CHARS:
            return text
    return _render(releases, 1)[: MAX_MESSAGE_CHARS - 1].rstrip() + "…"


def _render(releases: tuple[Release, ...], count: int) -> str:
    """The message with `count` releases spelled out and the rest counted."""
    shown = releases[:count]
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
    where two callers can still both be running.

    The cost is real and worth stating plainly, because it is easy to write down
    as smaller than it is: a send that fails after the claim loses those notes
    **permanently**. `releases_since` reads from the recorded version, so the
    next release names only what came after it — the lost one is not carried
    forward. That is still the right way round for a changelog nobody depends
    on, but it is a trade rather than a mitigation, and a future version of this
    that people *do* depend on wants the claim after the send plus a dedupe.

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

    With no notes on disk there is nothing to announce and, more to the point,
    nothing that may be *claimed*: recording `"unknown"` against a server would
    make the next real release look like an upgrade from a version that never
    existed. Returning early leaves the row exactly as it was.
    """
    if not RELEASES:
        return ""
    claimed, previously = claim_announcement(db, guild_id, version)
    if not claimed:
        return ""
    return format_announcement(releases_since(previously))
