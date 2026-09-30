"""
The internship tracker and `/bennxt` are gone from this bot, and stay gone.

    python3 -m unittest discover -s client     # no install needed

Internship alerts moved to a separate bot, DIAYN. These tests pin the ways the
old tracker could come back without anybody deciding it should:

  * a module: `internship_poller.py` or `resolve_boards.py` restored, imported,
    or named in a string the bot uses (it used to load the poller by path,
    which an import scan alone would not see);
  * a command: `/internships` or `/bennxt` registered again, whichever way
    discord.py lets a command be named;
  * a key: a `GEMINI_*` variable back in example.env, or read by the bot,
    inviting an operator to configure a model this bot no longer calls.

Each check is a function run twice: over the bot, where it must find nothing,
and over a sample that holds its target, where it must find it. A check that
recognised nothing would pass on any source.

The bot is read rather than imported, for the reason `test_puzzle_recap.py`
gives: importing `discord_bot.py` loads the repository's real .env
(override=True) and opens its real databases. Nothing here needs an install,
so it runs on a bare box too.
"""

import ast
import pathlib
import re
import types
import unittest

CLIENT = pathlib.Path(__file__).resolve().parent
ROOT = CLIENT.parent

REMOVED_MODULES = ("internship_poller", "resolve_boards")
REMOVED_COMMANDS = ("internships", "bennxt")
COMMAND_DECORATORS = ("command", "group", "hybrid_command", "hybrid_group")


def _bot_modules() -> list[pathlib.Path]:
    """Every module the bot is made of: client/*.py, tests aside."""
    return sorted(p for p in CLIENT.glob("*.py") if not p.name.startswith("test_"))


def _parse(path: pathlib.Path) -> ast.Module:
    return ast.parse(path.read_text(encoding="utf-8"), filename=str(path))


def _docstrings(tree: ast.AST) -> set[int]:
    """The ids of every docstring's node: history may be told there."""
    found = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            first = node.body[0] if node.body else None
            if (isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant)
                    and isinstance(first.value.value, str)):
                found.add(id(first.value))
    return found


def _strings(tree: ast.AST) -> list[str]:
    """Every string literal in `tree` that is not a docstring."""
    skip = _docstrings(tree)
    return [n.value for n in ast.walk(tree) if isinstance(n, ast.Constant)
            and isinstance(n.value, str) and id(n) not in skip]


def modules_imported(tree: ast.AST) -> set[str]:
    """The removed modules `tree` imports, either way."""
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            names.add((node.module or "").split(".")[0])
    return names & set(REMOVED_MODULES)


def modules_named(tree: ast.AST) -> list[str]:
    """Every non-docstring string naming a removed module: a path to load it by,
    a name for import_module or runpy, a subprocess argument."""
    return [s for s in _strings(tree) if any(module in s for module in REMOVED_MODULES)]


def gemini_keys_read(tree: ast.AST) -> list[str]:
    """Every non-docstring string that is a GEMINI_ key's name."""
    return [s for s in _strings(tree) if s.startswith("GEMINI_")]


def _decorated_as_command(node) -> bool:
    for decorator in node.decorator_list:
        func = decorator.func if isinstance(decorator, ast.Call) else decorator
        if isinstance(func, ast.Attribute) and func.attr in COMMAND_DECORATORS:
            return True
    return False


def command_names(tree: ast.Module) -> set[str]:
    """
    Every name discord.py could give a command in `tree`: a `name=` keyword; a
    positional first argument (`@bot.command("x")`); a class keyword
    (`class X(app_commands.Group, name="x")`); a Group subclass's own name; and,
    for a command given none of those, the name of the function it decorates,
    anywhere, or of anything bound at the top of the module.
    """
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            names.update(kw.value.value for kw in node.keywords
                         if kw.arg == "name" and isinstance(kw.value, ast.Constant)
                         and isinstance(kw.value.value, str))
            if (isinstance(node.func, ast.Attribute) and node.func.attr in COMMAND_DECORATORS
                    and node.args and isinstance(node.args[0], ast.Constant)
                    and isinstance(node.args[0].value, str)):
                names.add(node.args[0].value)
        elif isinstance(node, ast.ClassDef):
            names.update(kw.value.value for kw in node.keywords
                         if kw.arg == "name" and isinstance(kw.value, ast.Constant)
                         and isinstance(kw.value.value, str))
            names.add(node.name.lower())
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and _decorated_as_command(node):
            names.add(node.name)
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            names.add(node.name)
        elif isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            names.update(t.id for t in targets if isinstance(t, ast.Name))
    return names & set(REMOVED_COMMANDS)


ENV_KEY = re.compile(r"^\s*(?:#+\s*)?(?:export\s+)?(GEMINI_\w*)\s*=", re.MULTILINE)


def env_keys(text: str) -> list[str]:
    """GEMINI_ keys listed in an env file: commented out or exported, they count."""
    return ENV_KEY.findall(text)


# A module holding one of everything the checks look for, each written a way
# the checks must see through.
SAMPLE = ast.parse("""
\"\"\"A docstring may say internship_poller.py and GEMINI_API_KEY: history is allowed.\"\"\"
import internship_poller
from resolve_boards import resolve
spec = importlib.util.spec_from_file_location("p", ROOT / "internship_poller.py")
MODEL = os.environ.get("GEMINI_MODEL")
internships = app_commands.Group(name="internships", description="x")

async def bennxt(ctx):
    pass

def setup(bot):
    @bot.command()
    async def bennxt(ctx):
        pass
""")


class EveryCheckFindsWhatItLooksFor(unittest.TestCase):
    def test_imports_either_way(self):
        self.assertEqual(modules_imported(SAMPLE), set(REMOVED_MODULES))

    def test_a_module_named_in_a_string_but_not_in_a_docstring(self):
        self.assertEqual(modules_named(SAMPLE), ["internship_poller.py"])

    def test_a_gemini_key_read_but_not_one_told_of_in_a_docstring(self):
        self.assertEqual(gemini_keys_read(SAMPLE), ["GEMINI_MODEL"])

    def test_commands_by_keyword_top_level_name_and_nested_decorated_name(self):
        self.assertEqual(command_names(SAMPLE), set(REMOVED_COMMANDS))
        nested_only = ast.parse("def setup(bot):\n"
                                "    @bot.command()\n"
                                "    async def bennxt(ctx):\n"
                                "        pass\n")
        self.assertEqual(command_names(nested_only), {"bennxt"})

    def test_commands_named_the_other_ways(self):
        for source in ("@bot.command('bennxt')\nasync def a(ctx): ...\n",
                       "class B(app_commands.Group, name='internships'): ...\n",
                       "class Bennxt(app_commands.Group): ...\n"):
            with self.subTest(source=source):
                self.assertTrue(command_names(ast.parse(source)))

    def test_env_keys_plain_commented_and_exported(self):
        self.assertEqual(env_keys("GEMINI_API_KEY=\n#GEMINI_MODEL=x\n## GEMINI_RPD = 5\n"
                                  "export GEMINI_TPM=1\nDISCORD_TOKEN=\n"),
                         ["GEMINI_API_KEY", "GEMINI_MODEL", "GEMINI_RPD", "GEMINI_TPM"])


class TheTrackerModulesAreGone(unittest.TestCase):

    def test_neither_module_is_in_the_repository(self):
        for name in REMOVED_MODULES:
            for folder in (ROOT, CLIENT):
                with self.subTest(module=name, folder=folder.name):
                    self.assertFalse((folder / f"{name}.py").exists())

    def test_no_bot_module_imports_either_one(self):
        for path in _bot_modules():
            with self.subTest(file=path.name):
                self.assertEqual(modules_imported(_parse(path)), set())

    def test_no_bot_module_loads_either_one_by_path(self):
        for path in _bot_modules():
            with self.subTest(file=path.name):
                self.assertEqual(modules_named(_parse(path)), [])


class TheirCommandsAreGone(unittest.TestCase):
    def test_no_command_is_named_after_either_one(self):
        for path in _bot_modules():
            with self.subTest(file=path.name):
                self.assertEqual(command_names(_parse(path)), set())


class NoGeminiKey(unittest.TestCase):
    """
    example.env is the list an operator copies to make .env, so a key in it is
    a request to go and get one. Commented-out keys count: `#GEMINI_MODEL=` is
    still an invitation to uncomment it.
    """

    def test_example_env_lists_none(self):
        self.assertEqual(env_keys((ROOT / "example.env").read_text(encoding="utf-8")), [])

    def test_no_bot_module_reads_one(self):
        for path in _bot_modules():
            with self.subTest(file=path.name):
                self.assertEqual(gemini_keys_read(_parse(path)), [])


def _decide(condition: ast.expr, **names) -> bool:
    return bool(eval(compile(ast.Expression(condition), "<condition>", "eval"), names))


class TheReadyHookStillStartsTheClubLoops(unittest.TestCase):
    """
    The removal cut the tracker's lines out of on_ready. What stays must still
    run there: the command sync, in a try so a failure stops nothing after it,
    and the presence sampler, started once, directly in on_ready, only when its
    table was made and it is not already running. (test_puzzle_recap.py pins the
    recap's start the same way.)
    """

    TREE = _parse(CLIENT / "discord_bot.py")

    @classmethod
    def on_ready(cls):
        (hook,) = [n for n in ast.walk(cls.TREE)
                   if isinstance(n, ast.AsyncFunctionDef) and n.name == "on_ready"]
        return hook

    @staticmethod
    def _starts_presence(statement) -> bool:
        call = statement.value if isinstance(statement, ast.Expr) else None
        return (isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute)
                and call.func.attr == "start" and isinstance(call.func.value, ast.Name)
                and call.func.value.id == "presence_sample")

    def test_the_sync_is_awaited_inside_a_try(self):
        tries = [s for s in self.on_ready().body if isinstance(s, ast.Try)]
        awaited = [n.value.func.id for t in tries for s in t.body for n in ast.walk(s)
                   if isinstance(n, ast.Await) and isinstance(n.value, ast.Call)
                   and isinstance(n.value.func, ast.Name)]
        self.assertIn("_sync_global_commands", awaited)

    def test_the_presence_sampler_starts_once_directly_in_on_ready(self):
        everywhere = [n for n in ast.walk(self.TREE)
                      if isinstance(n, ast.Expr) and self._starts_presence(n)]
        gates = [s for s in self.on_ready().body if isinstance(s, ast.If)
                 and any(self._starts_presence(b) for b in s.body)]
        self.assertEqual((len(everywhere), len(gates)), (1, 1))

    def test_its_gate_starts_it_only_with_its_table_made_and_it_not_running(self):
        (gate,) = [s for s in self.on_ready().body if isinstance(s, ast.If)
                   and any(self._starts_presence(b) for b in s.body)]

        def starts(error, running):
            return _decide(gate.test, presence_error=error,
                           presence_sample=types.SimpleNamespace(is_running=lambda: running))

        self.assertTrue(starts(None, False))
        self.assertFalse(starts("OperationalError: x", False))
        self.assertFalse(starts(None, True))


if __name__ == "__main__":
    unittest.main()
