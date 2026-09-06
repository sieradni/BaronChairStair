"""
That the changelog actually reaches a channel, and reaches it silently.

`test_changelog.py` covers what the message says and who is owed one. This
covers the wiring: that `/puzzle` posts it, that it posts once, and — the part
the club asked for explicitly — that it **cannot ping anybody**.

`puzzle_commands` imports `discord` and `aiohttp` at module scope, and neither
is installed on a box running the suite with bare `python3`. Rather than skip,
the two are stubbed with just the surface this module touches: the point of
these tests is our own control flow, and a real gateway library would not make
them truer. Everything stubbed here is asserted against, so a stub that drifts
from the real thing shows up as a failing test rather than as a false pass.

One deliberate side effect, stated because it is surprising: installing the
stubs makes `puzzle_recap` importable too, so `test_puzzle_recap.py` stops
skipping on a bare-`python3` box and its checks run against the same stubs.
That is more coverage rather than less, but it does mean this file changes
whether another one skips.

`/puzzle` calling it at all is pinned by reading the source, not by driving the
command — driving it means an HTTP round trip to the activity, and the failure
worth catching is somebody deleting one line.
"""

import asyncio
import sqlite3
import sys
import types
import unittest


def _install_stubs() -> bool:
    """Fakes `discord` and `aiohttp`, unless the real ones are installed."""
    try:
        import discord  # noqa: F401
        import aiohttp  # noqa: F401
        return False
    except ModuleNotFoundError:
        pass

    discord = types.ModuleType("discord")

    class AllowedMentions:
        def __init__(self, everyone=True, users=True, roles=True):
            self.everyone, self.users, self.roles = everyone, users, roles

        @classmethod
        def none(cls):
            return cls(everyone=False, users=False, roles=False)

    class Embed:
        def __init__(self, **kwargs):
            self.fields = []
            self.__dict__.update(kwargs)

        def add_field(self, **kwargs):
            self.fields.append(kwargs)

        def set_footer(self, **kwargs):
            self.footer = kwargs

    class Colour:
        @staticmethod
        def from_rgb(*rgb):
            return rgb

    discord.AllowedMentions = AllowedMentions
    discord.Embed = Embed
    discord.Colour = Colour
    discord.Interaction = object
    discord.Message = object
    class HTTPException(Exception):
        # discord.py's takes (response, message). Constructing it with one
        # argument works here and raises there, which would make a test that
        # passes on a bare box fail on the bot's own machine.
        def __init__(self, response, message=None):
            super().__init__(message or "http error")
            self.response, self.text = response, message

    discord.HTTPException = HTTPException

    app_commands = types.ModuleType("discord.app_commands")

    def command(**_kwargs):
        return lambda fn: fn

    app_commands.command = command
    discord.app_commands = app_commands
    sys.modules["discord"] = discord
    sys.modules["discord.app_commands"] = app_commands

    aiohttp = types.ModuleType("aiohttp")
    aiohttp.ClientError = type("ClientError", (Exception,), {})
    aiohttp.ClientTimeout = lambda **kwargs: None
    aiohttp.ClientSession = object
    sys.modules["aiohttp"] = aiohttp
    return True


_install_stubs()

import changelog  # noqa: E402
import puzzle_commands  # noqa: E402


class Followup:
    """Records what the command tried to send."""

    def __init__(self, explode: bool = False):
        self.sent: list[dict] = []
        self.explode = explode

    async def send(self, content=None, **kwargs):
        if self.explode:
            raise sys.modules["discord"].HTTPException(object(), "nope")
        self.sent.append({"content": content, **kwargs})
        return object()


class Interaction:
    def __init__(self, guild_id: int | None, followup: Followup):
        self.guild_id = guild_id
        self.followup = followup


class Announcing(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        changelog.init_db(self.db)
        self._saved = puzzle_commands.version_db
        puzzle_commands.version_db = self.db

    def tearDown(self):
        puzzle_commands.version_db = self._saved
        self.db.close()

    def announce(self, guild_id=1, followup=None):
        followup = followup or Followup()
        asyncio.run(puzzle_commands._announce_new_version(Interaction(guild_id, followup)))
        return followup

    def test_the_first_run_posts_the_changelog(self):
        followup = self.announce()
        self.assertEqual(len(followup.sent), 1)
        self.assertIn(changelog.VERSION, followup.sent[0]["content"])

    def test_it_cannot_ping_anybody(self):
        # The club asked for no pings, and the text is ours rather than a
        # player's — so a release note containing @everyone must still be inert.
        mentions = self.announce().sent[0]["allowed_mentions"]
        self.assertFalse(mentions.everyone)
        self.assertFalse(mentions.users)
        self.assertFalse(mentions.roles)

    def test_the_second_run_posts_nothing(self):
        self.announce()
        self.assertEqual(self.announce().sent, [])

    def test_a_direct_message_is_left_alone(self):
        # No guild, nowhere to record it, and nobody to tell.
        self.assertEqual(self.announce(guild_id=None).sent, [])

    def test_without_a_database_it_stays_quiet_rather_than_raising(self):
        puzzle_commands.version_db = None
        self.assertEqual(self.announce().sent, [])

    def test_a_send_that_fails_does_not_take_the_command_down(self):
        # `/puzzle` has already answered by this point. Raising here would cost
        # the player the thing they actually asked for.
        self.announce(followup=Followup(explode=True))

    def test_a_send_that_fails_is_not_retried_into_a_double_post(self):
        # The claim is taken before the send, deliberately: losing one
        # announcement is better than posting it twice.
        self.announce(followup=Followup(explode=True))
        self.assertEqual(self.announce().sent, [])




class TheCommandActuallyCallsIt(unittest.TestCase):
    """
    That `/puzzle` still announces.

    Read off the source rather than driven: running the command means reaching
    the activity over HTTP, and the mistake worth catching is a deleted line,
    which no amount of stubbing the network would surface.
    """

    @staticmethod
    def _command_source() -> str:
        """
        `puzzle_command`'s body, read off the file.

        Not `inspect.getsource(puzzle_commands.puzzle_command)`: with the real
        `discord.py` installed the decorator has replaced the function with an
        `app_commands.Command`, and `getsource` raises on it. The stub here
        returns the function untouched, so that version passed on a bare box and
        would have failed on the bot's own machine.
        """
        import pathlib

        text = pathlib.Path(puzzle_commands.__file__).read_text()
        start = text.index("async def puzzle_command(")
        end = text.index("\ndef ", start)
        return text[start:end]

    def test_puzzle_command_announces_after_it_answers(self):
        body = self._command_source()
        self.assertIn(
            "_announce_new_version",
            body,
            "/puzzle no longer announces new versions. A server would sit on an "
            "old build forever without being told, and nothing else calls this.",
        )
        # After the puzzle is sent, not before: the changelog is a footnote to
        # the thing somebody asked for, and a failure to send it must not
        # displace the puzzle.
        #
        # Anchored on the send that posts the puzzle — the one whose result is
        # kept — rather than on the first `followup.send` in the text, which is
        # the unreachable-server branch further up. Anchored there, this
        # assertion passed however the two were ordered.
        self.assertLess(
            body.index("message = await interaction.followup.send"),
            body.index("_announce_new_version"),
            "the changelog is being sent before the puzzle it rides behind",
        )


class ItsOwnDatabaseHandle(unittest.TestCase):
    """
    That a recap failure cannot switch version announcements off.

    Both tables live in one file, but each feature is enabled only if its own
    table was made. Sharing `recap_db` meant a locked database during the
    recap's `init_db` disabled the changelog too, with the boot log naming the
    recap and `changelog_error` still None.
    """

    def test_the_two_features_have_separate_handles(self):
        self.assertIsNot(
            puzzle_commands.recap_db,
            "sentinel",
            "recap_db must still exist for the recap",
        )
        self.assertTrue(hasattr(puzzle_commands, "version_db"))

    def test_the_announcer_reads_its_own_handle(self):
        import inspect

        body = inspect.getsource(puzzle_commands._announce_new_version)
        self.assertIn("version_db", body)
        self.assertNotIn("recap_db", body,
                         "the changelog is gated on the recap's handle again")


if __name__ == "__main__":
    unittest.main()