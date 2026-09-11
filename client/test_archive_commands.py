"""
test_archive_commands.py
~~~~~~~~~~~~~~~~~~~~~~~~
The gate on `/archive sync`, and the process handling under it.

The gate is the whole reason this command needed writing carefully, so most of
what follows is about refusing. A permission check that is never tested is a
permission check that quietly stops checking.

Importing `test_changelog_wiring` first is deliberate and is not a dependency
between suites. That module owns `_install_stubs`, which fakes discord.py and
aiohttp for a box with neither installed, and it returns early when the real
libraries are present. Reusing it is the alternative to a second, drifting copy
of the same fakes — its own comment explains why the fake `app_commands` is as
small as it is. This module then adds the two attributes it needs on top, since
`archive_commands` is the first module in the repository to use a Group.
"""

import asyncio
import io
import contextlib
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path

import test_changelog_wiring  # noqa: F401 — imported for its stub installation

_app_commands = sys.modules["discord"].app_commands

if not hasattr(_app_commands, "Group"):
    # The stubbed app_commands from a sibling suite defines only `command`.
    # A real discord.py has all of this already and this block is skipped.
    class _Group:
        def __init__(self, name: str, description: str = ""):
            self.name, self.description = name, description

        def command(self, **_kwargs):
            return lambda fn: fn

    _app_commands.Group = _Group

if not hasattr(_app_commands, "describe"):
    _app_commands.describe = lambda **_kwargs: (lambda fn: fn)

import archive_commands  # noqa: E402
import puzzle_admins  # noqa: E402


#: With real discord.py the decorator has replaced the function with a Command
#: object; with the stub it is still the function. Either way this is the code.
CALLBACK = getattr(archive_commands.archive_sync, "callback", archive_commands.archive_sync)


class Response:
    """interaction.response — what a refusal answers on, before any defer."""

    def __init__(self):
        self.messages: list[dict] = []
        self.deferred = False

    async def send_message(self, content=None, **kwargs):
        self.messages.append({"content": content, **kwargs})

    async def defer(self, **kwargs):
        self.deferred = True


class Followup:
    def __init__(self):
        self.sent: list[dict] = []

    async def send(self, content=None, **kwargs):
        self.sent.append({"content": content, **kwargs})


class User:
    def __init__(self, user_id, name="someone"):
        self.id, self.name = user_id, name


class Interaction:
    def __init__(self, user):
        self.user = user
        self.response = Response()
        self.followup = Followup()


class TheGate(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self.addCleanup(self._dir.cleanup)
        self.path = Path(self._dir.name) / "puzzle-admins.json"
        self.path.write_text(json.dumps({"admins": [{"id": "1001", "who": "x"}]}),
                             encoding="utf-8")
        # Point the module at the temporary allowlist rather than the club's.
        self._real_path = puzzle_admins.ADMINS_PATH
        puzzle_admins.ADMINS_PATH = self.path
        self.addCleanup(setattr, puzzle_admins, "ADMINS_PATH", self._real_path)
        # Nothing in this class should reach a subprocess.
        self.calls: list[dict] = []

        async def fake_sync(dry_run, by, cwd=None):
            self.calls.append({"dry_run": dry_run, "by": by})
            return 0, "added 0, amended 0, unchanged 163"

        self._real_sync = archive_commands.run_sync
        archive_commands.run_sync = fake_sync
        self.addCleanup(setattr, archive_commands, "run_sync", self._real_sync)

    async def test_an_unlisted_user_is_refused(self):
        interaction = Interaction(User(2002))
        await CALLBACK(interaction)
        self.assertEqual(len(interaction.response.messages), 1)
        self.assertEqual(self.calls, [], "a refused user must not start a sync")

    async def test_the_refusal_is_private(self):
        # "You are not an officer" read out in the channel is a scolding with
        # an audience; this repository answers refusals ephemerally.
        interaction = Interaction(User(2002))
        await CALLBACK(interaction)
        self.assertTrue(interaction.response.messages[0]["ephemeral"])

    async def test_the_refusal_answers_before_any_defer(self):
        # Deferring first would make every later followup ephemeral too, and
        # would post a visible "thinking" for a command about to be refused.
        interaction = Interaction(User(2002))
        await CALLBACK(interaction)
        self.assertFalse(interaction.response.deferred)

    async def test_the_refusal_says_how_to_be_added(self):
        interaction = Interaction(User(2002))
        await CALLBACK(interaction)
        said = interaction.response.messages[0]["content"]
        self.assertIn(puzzle_admins.ADMINS_PATH.name, said)

    async def test_an_empty_allowlist_refuses_everybody(self):
        self.path.write_text(json.dumps({"admins": []}), encoding="utf-8")
        await CALLBACK(Interaction(User(1001)))
        self.assertEqual(self.calls, [])

    async def test_a_missing_allowlist_refuses_everybody(self):
        self.path.unlink()
        await CALLBACK(Interaction(User(1001)))
        self.assertEqual(self.calls, [])

    async def test_a_malformed_allowlist_refuses_everybody(self):
        # The failure this module exists to avoid: a fat-fingered comma must
        # not hand the archive to whoever types the command next.
        self.path.write_text("{ not json", encoding="utf-8")
        with contextlib.redirect_stderr(io.StringIO()):
            await CALLBACK(Interaction(User(1001)))
        self.assertEqual(self.calls, [])

    async def test_a_listed_user_gets_through(self):
        interaction = Interaction(User(1001))
        await CALLBACK(interaction)
        self.assertEqual(len(self.calls), 1)
        self.assertTrue(interaction.response.deferred, "the work is announced publicly")
        self.assertEqual(len(interaction.followup.sent), 1)

    async def test_a_listed_user_added_while_the_bot_runs_gets_through(self):
        # The reason the file is read per call rather than at import: adding an
        # officer must not need a restart, which is the operation DEPLOY.md
        # warns can leave two instances on one token.
        await CALLBACK(Interaction(User(3003)))
        self.assertEqual(self.calls, [])
        self.path.write_text(json.dumps({"admins": ["1001", "3003"]}), encoding="utf-8")
        await CALLBACK(Interaction(User(3003)))
        self.assertEqual(len(self.calls), 1)

    async def test_the_runner_is_told_who_asked(self):
        await CALLBACK(Interaction(User(1001, name="zhiyuan")))
        self.assertIn("zhiyuan", self.calls[0]["by"])

    async def test_dry_run_is_passed_through_and_announced(self):
        interaction = Interaction(User(1001))
        await CALLBACK(interaction, dry_run=True)
        self.assertTrue(self.calls[0]["dry_run"])
        self.assertIn("Dry run", interaction.followup.sent[0]["content"])

    async def test_a_second_sync_while_one_runs_is_refused(self):
        started = asyncio.Event()
        release = asyncio.Event()

        async def slow_sync(dry_run, by, cwd=None):
            started.set()
            await release.wait()
            return 0, "done"

        archive_commands.run_sync = slow_sync
        first = asyncio.create_task(CALLBACK(Interaction(User(1001))))
        await started.wait()

        second = Interaction(User(1001))
        await CALLBACK(second)
        self.assertIn("already running", second.response.messages[0]["content"])
        self.assertFalse(second.response.deferred)

        release.set()
        await first


class ReadingTheResult(unittest.TestCase):
    def test_the_verdicts_distinguish_the_tools_exit_codes(self):
        # Treating any non-zero as failure would report the tool's expected
        # work — a content edit — as a fault.
        self.assertEqual(archive_commands.verdict(0, dry_run=False), "Synced.")
        self.assertIn("changed content", archive_commands.verdict(2, dry_run=False))
        self.assertIn("would not write", archive_commands.verdict(1, dry_run=False))
        self.assertIn("failed", archive_commands.verdict(-1, dry_run=False))

    def test_a_dry_run_says_it_wrote_nothing(self):
        self.assertIn("nothing left over", archive_commands.verdict(0, dry_run=True))

    def test_short_output_is_left_alone(self):
        self.assertEqual(archive_commands._clip("added 1, amended 0"), "added 1, amended 0")

    def test_long_output_keeps_the_tail(self):
        # The summary and the skipped rows are at the end; head-truncation
        # would cut exactly the part somebody needs.
        body = "\n".join(f"line {n}" for n in range(500)) + "\nTHE LAST WORD"
        clipped = archive_commands._clip(body, limit=100)
        self.assertIn("THE LAST WORD", clipped)
        self.assertTrue(clipped.startswith("…"))
        self.assertLessEqual(len(clipped), 104)


class StartingTheProcess(unittest.IsolatedAsyncioTestCase):
    async def test_a_missing_activity_directory_says_so(self):
        # And does not blame Bun. create_subprocess_exec raises the same
        # FileNotFoundError for a missing executable and a missing cwd.
        code, message = await archive_commands.run_sync(
            dry_run=True, by="test", cwd=Path("/nope/not/here")
        )
        self.assertEqual(code, -1)
        self.assertIn("PUZZLE_ACTIVITY_DIR", message)
        self.assertNotIn("PATH", message)

    async def test_it_runs_the_safe_sync_and_never_publish(self):
        seen: dict = {}

        async def fake_exec(*argv, **kwargs):
            seen["argv"], seen["cwd"] = argv, kwargs.get("cwd")
            raise FileNotFoundError("no bun here")

        real = asyncio.create_subprocess_exec
        asyncio.create_subprocess_exec = fake_exec
        try:
            with tempfile.TemporaryDirectory() as here:
                await archive_commands.run_sync(dry_run=True, by="me", cwd=Path(here))
        finally:
            asyncio.create_subprocess_exec = real

        self.assertEqual(seen["argv"][:3], ("bun", "run", "sync-archive"))
        self.assertIn("--dry-run", seen["argv"])
        # The two tools CLAUDE.md reserves for a terminal must never appear.
        self.assertNotIn("publish-archive", seen["argv"])
        self.assertNotIn("puzzles", seen["argv"])

    async def test_a_missing_bun_blames_bun(self):
        async def fake_exec(*argv, **kwargs):
            raise FileNotFoundError("no bun here")

        real = asyncio.create_subprocess_exec
        asyncio.create_subprocess_exec = fake_exec
        try:
            with tempfile.TemporaryDirectory() as here:
                code, message = await archive_commands.run_sync(
                    dry_run=False, by="me", cwd=Path(here)
                )
        finally:
            asyncio.create_subprocess_exec = real
        self.assertEqual(code, -1)
        self.assertIn("PATH", message)


if __name__ == "__main__":
    unittest.main()
