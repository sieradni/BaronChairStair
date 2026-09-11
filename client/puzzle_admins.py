"""
puzzle_admins.py
~~~~~~~~~~~~~~~~
Who is allowed to run the archive commands.

A hand-edited list of Discord user ids in a JSON file the owner keeps beside
the changelog. Stdlib only, and no Discord types in the signatures, so it can
be tested on a box with no discord.py installed — the same reason
`report_text.py` holds the rate limiter rather than `report_commands.py`.

Two deliberate departures from `changelog.py`, which is otherwise the model for
this module and worth reading first:

**It fails closed.** A missing, unreadable or malformed file means *nobody* is
allowed, not everybody. Every other config loader in this repository degrades
permissively — the changelog goes quiet, `boards.json` falls back to a seed
list, `/report` says it is not wired up — because for all of them the open
state is the harmless one. Here it is the whole point of the file, and a
loader that copied that habit would hand the archive to the first person who
typed the command on the day somebody fat-fingered a comma.

**It reads on every call.** `changelog.py` reads once at import, which is right
for release notes and wrong for a file whose entire purpose is that somebody
edits it by hand. Rereading costs one `open()` on a file with a handful of
lines, against the alternative of restarting the bot to add a person — and a
restart is the operation `DEPLOY.md` warns can leave two instances on one token.

**Never raises.** `discord_bot.py` imports its command modules at top level and
outside a `try`, so an exception here would be a bot that will not start over a
config file. Problems are printed to stderr and read as "nobody is allowed".
"""

import json
import sys
from pathlib import Path

#: Where the allowlist lives. Beside this file's *project*, not beside this
#: file: `client/` is half of a repository the activity shares, and this is the
#: same anchoring `changelog.py` uses for `changelog.json`.
ADMINS_PATH = Path(__file__).resolve().parent.parent / "puzzle-admins.json"

#: Shipped in git, unlike the real file, so a fresh clone can see the shape.
EXAMPLE_PATH = Path(__file__).resolve().parent.parent / "puzzle-admins.example.json"


def load_admins(path: "Path | None" = None) -> frozenset[str]:
    """
    The set of Discord user ids allowed to run the archive commands.

    Ids are **strings**, and are compared against `str(interaction.user.id)`.
    Discord snowflakes are 64-bit; the activity models player ids as strings
    for the same reason, and a JSON number here would be a precision bug
    waiting for the day something other than Python reads this file.

    Returns an empty set — refusing everybody — when the file is absent,
    unreadable, or not the shape it should be. That is not a failure mode to
    work around; it is the answer. See the module docstring.

    `path` defaults to None rather than to `ADMINS_PATH`, and is resolved here.
    A default argument is bound once, when the function is defined, so
    `path: Path = ADMINS_PATH` would freeze the location at import and quietly
    ignore anybody who reassigned the module attribute afterwards — including
    the tests, which is how this was found.
    """
    path = ADMINS_PATH if path is None else path
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        entries = raw["admins"]
    except FileNotFoundError:
        # Not worth shouting about on every invocation: a club that has not set
        # the command up yet is the common case, and the command itself tells
        # whoever tried how to fix it.
        return frozenset()
    except (OSError, ValueError, KeyError, TypeError) as exc:
        print(
            f"puzzle-admins: cannot read {path} ({exc}); nobody may run the "
            "archive commands until it parses",
            file=sys.stderr,
        )
        return frozenset()

    admins: set[str] = set()
    # `entries` came out of JSON and has been no further checked than "the key
    # was there". A string is iterable, so `"123"` where a list belongs would
    # otherwise enrol the characters 1, 2 and 3 as three separate officers.
    if isinstance(entries, (str, bytes)) or not hasattr(entries, "__iter__"):
        print(
            f"puzzle-admins: \"admins\" in {path} is "
            f"{type(entries).__name__}, not a list; nobody may run the "
            "archive commands until it is",
            file=sys.stderr,
        )
        return frozenset()

    for entry in entries:
        # Both shapes, because this file is typed by a person. The documented
        # one carries a name beside the id so the file explains itself; a bare
        # string is what somebody writes in a hurry, and refusing it would mean
        # an officer locked out by a reasonable guess at the format.
        value = entry.get("id") if isinstance(entry, dict) else entry
        if not isinstance(value, (str, int)) or isinstance(value, bool):
            print(
                f"puzzle-admins: skipping an entry in {path} whose id is "
                f"{type(value).__name__}, not a string",
                file=sys.stderr,
            )
            continue
        text = str(value).strip()
        if text:
            admins.add(text)
    return frozenset(admins)


def is_admin(user_id: object, path: "Path | None" = None) -> bool:
    """
    Whether this user may run the archive commands.

    Takes the id as `object` and stringifies it, so a caller cannot get the
    comparison wrong by passing the `int` that `interaction.user.id` actually
    is. `None` is refused rather than stringified into the literal "None",
    which is the one value a typo'd file could otherwise match.
    """
    if user_id is None:
        return False
    return str(user_id) in load_admins(path)
