"""
The internship tracker and `/bennxt` are gone from this bot, and stay gone.

    python3 -m unittest discover -s client     # no install needed

Internship alerts moved to a separate bot, DIAYN. These tests pin the three
ways the old tracker could come back without anybody deciding it should:

  * a module — `internship_poller.py` or `resolve_boards.py` restored, or
    loaded again by the bot (it used to load the poller by path, which an
    import scan alone would not see);
  * a command — `/internships` or `/bennxt` registered on the tree again;
  * a key — a `GEMINI_*` variable back in example.env, inviting an operator to
    configure a model this bot no longer calls.

The bot is read rather than imported, for the reason `test_puzzle_recap.py`
gives: importing `discord_bot.py` loads the repository's real .env
(override=True) and opens its real databases. Nothing here needs an install,
so it runs on a bare box too.
"""

import ast
import pathlib
import re
import unittest

CLIENT = pathlib.Path(__file__).resolve().parent
ROOT = CLIENT.parent

REMOVED_MODULES = ("internship_poller", "resolve_boards")
REMOVED_COMMANDS = ("internships", "bennxt")


def _bot_modules() -> list[pathlib.Path]:
    """Every module the bot is made of — client/*.py, tests aside."""
    return sorted(p for p in CLIENT.glob("*.py") if not p.name.startswith("test_"))


def _parse(path: pathlib.Path) -> ast.Module:
    return ast.parse(path.read_text(encoding="utf-8"), filename=str(path))


def _strings_in(node: ast.AST) -> list[str]:
    """Every string literal under `node` — `ROOT / "x.py"` included."""
    return [n.value for n in ast.walk(node)
            if isinstance(n, ast.Constant) and isinstance(n.value, str)]


class TheTrackerModulesAreGone(unittest.TestCase):

    def test_neither_module_is_in_the_repository(self):
        for name in REMOVED_MODULES:
            for folder in (ROOT, CLIENT):
                with self.subTest(module=name, folder=folder.name):
                    self.assertFalse((folder / f"{name}.py").exists())

    def test_no_bot_module_imports_either_one(self):
        for path in _bot_modules():
            for node in ast.walk(_parse(path)):
                if isinstance(node, ast.Import):
                    names = [alias.name for alias in node.names]
                elif isinstance(node, ast.ImportFrom):
                    names = [node.module or ""]
                else:
                    continue
                for name in names:
                    with self.subTest(file=path.name, line=node.lineno):
                        self.assertNotIn(name.split(".")[0], REMOVED_MODULES)

    def test_no_bot_module_loads_either_one_by_path(self):
        # A call whose arguments name the file: spec_from_file_location,
        # import_module, runpy, subprocess — whichever it would be. Docstrings
        # and comments are not calls, so mentioning the history stays allowed.
        for path in _bot_modules():
            for node in ast.walk(_parse(path)):
                if not isinstance(node, ast.Call):
                    continue
                arguments = [*node.args, *(kw.value for kw in node.keywords)]
                named = [s for arg in arguments for s in _strings_in(arg)
                         if any(module in s for module in REMOVED_MODULES)]
                with self.subTest(file=path.name, line=node.lineno):
                    self.assertEqual(named, [])


class TheirCommandsAreGone(unittest.TestCase):
    """
    Every command here is named one of two ways: a `name=` keyword (a slash
    command, a group, a prefix command given one) or, for a prefix command
    given none, the name of the function or variable it is bound to. Both are
    read, across every bot module, since a command defined anywhere under
    client/ can be added to the tree from discord_bot.py.
    """

    @staticmethod
    def _names_given(tree: ast.Module) -> set[str]:
        return {kw.value.value for node in ast.walk(tree) if isinstance(node, ast.Call)
                for kw in node.keywords
                if kw.arg == "name" and isinstance(kw.value, ast.Constant)
                and isinstance(kw.value.value, str)}

    @staticmethod
    def _names_bound(tree: ast.Module) -> set[str]:
        bound = set()
        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                bound.add(node.name)
            elif isinstance(node, (ast.Assign, ast.AnnAssign)):
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                bound.update(t.id for t in targets if isinstance(t, ast.Name))
        return bound

    @staticmethod
    def _names_other_ways(tree: ast.Module) -> set[str]:
        """The three other ways discord.py names a command.

        A positional first argument (`@bot.command("x")`, `@bot.group("x")`),
        a class keyword (`class X(app_commands.Group, name="x")`), and a Group
        subclass with neither, which discord.py names after the class.
        """
        names = set()
        for node in ast.walk(tree):
            if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                    and node.func.attr in ("command", "group", "hybrid_command", "hybrid_group")
                    and node.args and isinstance(node.args[0], ast.Constant)
                    and isinstance(node.args[0].value, str)):
                names.add(node.args[0].value)
            elif isinstance(node, ast.ClassDef):
                names.update(kw.value.value for kw in node.keywords
                             if kw.arg == "name" and isinstance(kw.value, ast.Constant)
                             and isinstance(kw.value.value, str))
                names.add(node.name.lower())
        return names

    def test_no_command_is_named_after_either_one_any_other_way(self):
        for path in _bot_modules():
            tree = _parse(path)
            for command in REMOVED_COMMANDS:
                with self.subTest(file=path.name, command=command):
                    self.assertNotIn(command, self._names_other_ways(tree))

    def test_the_other_ways_are_all_recognised(self):
        # A guard that recognises nothing passes on any source, so show it
        # catching each form on a sample.
        sample = ast.parse(
            "@bot.command('bennxt')\nasync def a(ctx): ...\n"
            "class B(app_commands.Group, name='internships'): ...\n"
            "class Bennxt(app_commands.Group): ...\n")
        self.assertEqual(self._names_other_ways(sample) & set(REMOVED_COMMANDS),
                         set(REMOVED_COMMANDS))

    def test_no_command_is_named_after_either_one(self):
        for path in _bot_modules():
            tree = _parse(path)
            for command in REMOVED_COMMANDS:
                with self.subTest(file=path.name, command=command):
                    self.assertNotIn(command, self._names_given(tree))

    def test_nothing_in_the_bot_is_bound_to_either_name(self):
        for path in _bot_modules():
            tree = _parse(path)
            for command in REMOVED_COMMANDS:
                with self.subTest(file=path.name, command=command):
                    self.assertNotIn(command, self._names_bound(tree))


class ExampleEnvOffersNoGeminiKey(unittest.TestCase):
    """
    example.env is the list an operator copies to make .env, so a key in it is
    a request to go and get one. Commented-out keys count: `#GEMINI_MODEL=` is
    still an invitation to uncomment it.
    """

    KEY = re.compile(r"^\s*#?\s*(GEMINI_\w*)\s*=", re.MULTILINE)

    def test_no_gemini_key_is_listed(self):
        text = (ROOT / "example.env").read_text(encoding="utf-8")
        self.assertEqual(self.KEY.findall(text), [])


if __name__ == "__main__":
    unittest.main()
