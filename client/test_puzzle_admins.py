"""
test_puzzle_admins.py
~~~~~~~~~~~~~~~~~~~~~
The allowlist behind `/archive sync`.

Stdlib `unittest` and no third-party imports, matching `test_report_text.py`'s
stated reason: this repository has no Python test harness, no pyproject and no
requirements file, so a suite that needs an install is a suite nobody runs.
`puzzle_admins` imports nothing outside the stdlib for the same reason, which
is why this file needs no discord.py stubs.

Most of what follows is about the loader saying *no*. That is deliberate: an
allowlist has one interesting failure and it is failing open, so the cases
worth spending tests on are the malformed ones.
"""

import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

import puzzle_admins


def load_quietly(path):
    """The loader plus whatever it complained about, the way test_changelog does."""
    stderr = io.StringIO()
    with contextlib.redirect_stderr(stderr):
        admins = puzzle_admins.load_admins(path)
    return admins, stderr.getvalue()


class ReadingTheList(unittest.TestCase):
    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self.addCleanup(self._dir.cleanup)
        self.path = Path(self._dir.name) / "puzzle-admins.json"

    def write(self, body: str):
        self.path.write_text(body, encoding="utf-8")
        return self.path

    def test_reads_the_documented_shape(self):
        self.write(json.dumps({"admins": [
            {"id": "1001", "who": "an officer"},
            {"id": "1002", "who": "another"},
        ]}))
        self.assertEqual(puzzle_admins.load_admins(self.path), frozenset({"1001", "1002"}))

    def test_a_bare_string_is_accepted_too(self):
        # Somebody in a hurry writes the id on its own. Refusing that would
        # lock an officer out over a reasonable guess at the format.
        self.write(json.dumps({"admins": ["1001", {"id": "1002", "who": "x"}]}))
        self.assertEqual(puzzle_admins.load_admins(self.path), frozenset({"1001", "1002"}))

    def test_an_id_written_as_a_number_is_read_as_a_string(self):
        # The file asks for strings, but a number is the obvious mistake and
        # the value survives it in Python. Comparison is on text either way.
        self.write(json.dumps({"admins": [{"id": 1001, "who": "x"}]}))
        self.assertEqual(puzzle_admins.load_admins(self.path), frozenset({"1001"}))

    def test_whitespace_is_trimmed_and_blanks_dropped(self):
        self.write(json.dumps({"admins": ["  1001  ", "", "   "]}))
        self.assertEqual(puzzle_admins.load_admins(self.path), frozenset({"1001"}))


class FailingClosed(unittest.TestCase):
    """The half that matters. Every one of these must mean nobody."""

    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self.addCleanup(self._dir.cleanup)
        self.path = Path(self._dir.name) / "puzzle-admins.json"

    def test_a_missing_file_allows_nobody(self):
        self.assertEqual(puzzle_admins.load_admins(self.path), frozenset())
        self.assertFalse(puzzle_admins.is_admin("1001", self.path))

    def test_a_missing_file_is_quiet(self):
        # The common case for a club that has not set this up. The command
        # itself explains; the log does not need a line per invocation.
        _, complaint = load_quietly(self.path)
        self.assertEqual(complaint, "")

    def test_malformed_json_allows_nobody_and_says_so(self):
        self.path.write_text("{ not json", encoding="utf-8")
        admins, complaint = load_quietly(self.path)
        self.assertEqual(admins, frozenset())
        self.assertIn("cannot read", complaint)

    def test_a_missing_admins_key_allows_nobody(self):
        self.path.write_text(json.dumps({"officers": ["1001"]}), encoding="utf-8")
        admins, complaint = load_quietly(self.path)
        self.assertEqual(admins, frozenset())
        self.assertIn("cannot read", complaint)

    def test_admins_as_a_string_does_not_enrol_its_characters(self):
        # A string is iterable. Looping it would make "123" three officers
        # named 1, 2 and 3 — and "1" is not a real id, but the failure is that
        # the loader answered yes to anything at all.
        self.path.write_text(json.dumps({"admins": "1001"}), encoding="utf-8")
        admins, complaint = load_quietly(self.path)
        self.assertEqual(admins, frozenset())
        self.assertIn("not a list", complaint)

    def test_an_empty_list_allows_nobody(self):
        self.path.write_text(json.dumps({"admins": []}), encoding="utf-8")
        self.assertEqual(puzzle_admins.load_admins(self.path), frozenset())

    def test_one_bad_entry_costs_that_entry_and_not_the_file(self):
        self.path.write_text(json.dumps({"admins": [
            {"who": "no id at all"},
            {"id": None},
            {"id": True},
            {"id": ["1003"]},
            {"id": "1001", "who": "fine"},
        ]}), encoding="utf-8")
        admins, complaint = load_quietly(self.path)
        self.assertEqual(admins, frozenset({"1001"}))
        self.assertIn("skipping", complaint)

    def test_a_boolean_id_is_not_read_as_a_number(self):
        # bool is a subclass of int in Python, so `True` would otherwise
        # stringify into the id "True" and sit in the set looking plausible.
        self.path.write_text(json.dumps({"admins": [True]}), encoding="utf-8")
        admins, _ = load_quietly(self.path)
        self.assertEqual(admins, frozenset())


class AskingAboutAUser(unittest.TestCase):
    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self.addCleanup(self._dir.cleanup)
        self.path = Path(self._dir.name) / "puzzle-admins.json"
        self.path.write_text(json.dumps({"admins": [{"id": "1001", "who": "x"}]}),
                             encoding="utf-8")

    def test_a_listed_user_is_allowed(self):
        self.assertTrue(puzzle_admins.is_admin("1001", self.path))

    def test_the_int_discord_actually_hands_over_is_allowed(self):
        # interaction.user.id is an int. The whole point of taking `object` and
        # stringifying is that a caller cannot get this comparison wrong.
        self.assertTrue(puzzle_admins.is_admin(1001, self.path))

    def test_an_unlisted_user_is_refused(self):
        self.assertFalse(puzzle_admins.is_admin("1002", self.path))

    def test_none_is_refused_rather_than_stringified(self):
        # Without the guard this asks whether "None" is in the file, which a
        # typo could make true.
        self.assertFalse(puzzle_admins.is_admin(None, self.path))

    def test_a_listed_user_is_refused_once_removed_from_the_file(self):
        # The file is read per call, not at import: an officer removed is an
        # officer removed, with no bot restart.
        self.assertTrue(puzzle_admins.is_admin("1001", self.path))
        self.path.write_text(json.dumps({"admins": []}), encoding="utf-8")
        self.assertFalse(puzzle_admins.is_admin("1001", self.path))


class WhereItLooks(unittest.TestCase):
    def test_reassigning_the_module_path_changes_where_it_reads(self):
        # The trap this module fell into once: `path: Path = ADMINS_PATH` binds
        # the default when the function is defined, so anybody who reassigns
        # the module attribute afterwards is silently ignored. It presents as
        # an officer on the list being refused, which is a bad afternoon.
        with tempfile.TemporaryDirectory() as here:
            elsewhere = Path(here) / "somewhere-else.json"
            elsewhere.write_text(json.dumps({"admins": ["4004"]}), encoding="utf-8")
            real = puzzle_admins.ADMINS_PATH
            puzzle_admins.ADMINS_PATH = elsewhere
            try:
                self.assertTrue(puzzle_admins.is_admin("4004"))
            finally:
                puzzle_admins.ADMINS_PATH = real


class TheExampleThatShips(unittest.TestCase):
    def test_it_parses_and_shows_the_documented_shape(self):
        # Tracked, unlike the real file, so this can read it unconditionally —
        # the same check test_changelog makes against changelog.json.
        path = puzzle_admins.EXAMPLE_PATH
        self.assertTrue(path.is_file(), f"{path} should ship in git")
        raw = json.loads(path.read_text(encoding="utf-8"))
        self.assertTrue(raw["admins"], "the example should show at least one entry")
        for entry in raw["admins"]:
            self.assertIsInstance(entry["id"], str, "ids are strings, never numbers")
            self.assertIn("who", entry, "each example entry names who it is")

    def test_the_real_file_is_not_committed(self):
        # The rule this repository cannot walk back: history here is
        # append-only, so an id committed by mistake stays committed.
        self.assertFalse(
            puzzle_admins.ADMINS_PATH.name in _tracked_names(),
            "puzzle-admins.json must stay untracked — it holds real Discord ids",
        )


def _tracked_names() -> set[str]:
    import subprocess
    root = puzzle_admins.ADMINS_PATH.parent
    try:
        out = subprocess.run(
            ["git", "ls-files"], cwd=root, capture_output=True, text=True, timeout=30
        )
    except (OSError, subprocess.SubprocessError):
        return set()
    return {Path(line).name for line in out.stdout.splitlines()}


if __name__ == "__main__":
    unittest.main()
