#!/usr/bin/env bun
/**
 * Checks every puzzle's own answer against its own solve condition.
 *
 *     bun run audit-archive [--from <dir>] [--json]
 *
 * The question this answers is narrow and worth stating exactly: **would the
 * author's intended solution be accepted by the server that judges players?**
 * It runs that answer through `solvesPuzzle` — the one function the client's
 * run loop and all four server verdicts share — so a puzzle this flags is one
 * where somebody can reproduce the intended line exactly and still be told they
 * failed.
 *
 * That is the definition of a bugged puzzle here, and it is not hypothetical:
 * `targetAttack` is derived from the answer and so is always met, but
 * `requiredClears` is *frozen* separately, and a puzzle whose answer changed
 * after its requirement was frozen now demands a clear its own solution never
 * makes.
 *
 * Three verdicts, in descending severity:
 *
 * - `BROKEN` — nobody can solve it as specified. The answer will not decode or
 *   replay, or it replays and still fails the puzzle's own solve condition.
 * - `GOAL` — the answer is fine and the *written goal* disagrees with it: the
 *   goal text parses into a requirement the intended solution does not meet.
 *   Players are not judged on prose, so this misleads rather than blocks.
 * - `OK`.
 *
 * Read-only. It writes nothing and touches no database.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseGoal, parseGoalLoosely } from "../shared/goal";
import {
  type ClearName,
  clearShortfall,
  meetsTarget,
  pieceBudget,
  type Puzzle,
  solvesPuzzle,
} from "../shared/puzzle";
import { CODES_SHEET, META_SHEET, buildPuzzle, indexById } from "./decode-archive";
import { parseCsv } from "./csv";

const SHEET_ID = "1OUA3w3Q1OAajaNLlp74CwrZhnBKRbkeo4hYux_v94QM";
const TAB_OF: Readonly<Record<string, string>> = {
  [CODES_SHEET]: "blueprint urls",
  [META_SHEET]: "Puzzles",
};

type Verdict = "BROKEN" | "GOAL" | "UNREADABLE" | "OK";

interface Audit {
  id: number;
  title: string;
  author: string;
  goal?: string;
  verdict: Verdict;
  problems: string[];
  attack?: number;
  clears?: ClearName[];
}

/**
 * The frozen clear requirements, which are what players are actually judged
 * against. They live in the committed archive rather than on the sheet — the
 * sheet has no column for them — so a puzzle can only be audited against its
 * real solve condition by reading them from here.
 */
function frozenRequirements(path: string): Map<number, Puzzle["requiredClears"]> {
  const file = JSON.parse(readFileSync(path, "utf8")) as { puzzles: Puzzle[] };
  const byId = new Map<number, Puzzle["requiredClears"]>();
  for (const puzzle of file.puzzles) {
    if (puzzle.requiredClears?.length) byId.set(puzzle.id, puzzle.requiredClears);
  }
  return byId;
}

function clearsOf(puzzle: Puzzle): ClearName[] {
  return (puzzle.solution ?? [])
    .map((step) => step.clear)
    .filter((clear): clear is ClearName => Boolean(clear));
}

function audit(puzzle: Puzzle): Audit {
  const problems: string[] = [];
  const attack = puzzle.targetAttack;
  const clears = clearsOf(puzzle);

  // The condition the server judges a player against, applied to the author.
  if (!solvesPuzzle(attack, clears, puzzle)) {
    const missing = clearShortfall(clears, puzzle.requiredClears);
    if (missing.length) {
      problems.push(
        `the intended solution does not meet the puzzle's own required clears — ` +
          `short ${missing.map((m) => `${m.count}x ${m.clear}`).join(", ")}` +
          `${clears.length ? ` (it makes: ${clears.join(", ")})` : " (it clears nothing)"}`,
      );
    }
    if (!meetsTarget(attack, puzzle.targetAttack)) {
      problems.push(`the intended solution sends ${attack}, short of its own target ${puzzle.targetAttack}`);
    }
  }

  if (attack <= 0) problems.push("the intended solution sends no attack, so there is nothing to score");

  const budget = pieceBudget(puzzle);
  const used = (puzzle.solution ?? []).length;
  if (used > budget) {
    problems.push(`the intended solution places ${used} pieces but only ${budget} are available`);
  }

  const broken = problems.length > 0;

  // A written goal that disagrees with the answer. Not a blocker -- players are
  // judged on requiredClears, not on prose -- but it is how a puzzle ends up
  // asking for something its answer never does, and it is how the frozen
  // requirement gets frozen wrong in the first place.
  const goalProblems: string[] = [];
  // The strict parser reads only 81 of 151 goals on the club's sheet; the loose
  // one is what the review tool falls back to, and it reaches 128. Using strict
  // alone silently skipped the goal check on nearly half the archive.
  const strict = parseGoal(puzzle.goal);
  const meaningful = (g: ReturnType<typeof parseGoal>) =>
    g !== null && (g.clears.length > 0 || g.attack > 0);
  const spec = meaningful(strict) ? strict : parseGoalLoosely(puzzle.goal);
  const readable = meaningful(spec);
  if (spec && readable) {
    const short = clearShortfall(clears, spec.clears);
    if (short.length) {
      goalProblems.push(
        `the goal "${puzzle.goal}" asks for ${spec.clears
          .map((c) => `${c.count}x ${c.clear}`)
          .join(", ")}, and the intended solution makes ${clears.join(", ") || "no clears"}`,
      );
    }
    if (spec.attack > 0 && !meetsTarget(attack, spec.attack)) {
      goalProblems.push(`the goal asks for ${spec.attack} attack and the answer sends ${attack}`);
    }
  }

  return {
    id: puzzle.id,
    title: puzzle.title,
    author: puzzle.author,
    goal: puzzle.goal,
    verdict: broken
      ? "BROKEN"
      : goalProblems.length
        ? "GOAL"
        : readable
          ? "OK"
          : "UNREADABLE",
    problems: [...problems, ...goalProblems],
    attack,
    clears,
  };
}

async function readTab(from: string | null, sheet: string): Promise<string> {
  if (from) return readFileSync(join(from, sheet), "utf8");
  const response = await fetch(
    `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq` +
      `?tqx=out:csv&sheet=${encodeURIComponent(TAB_OF[sheet]!)}`,
  );
  if (!response.ok) throw new Error(`Sheet tab "${TAB_OF[sheet]}" answered ${response.status}`);
  return response.text();
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const fromAt = argv.indexOf("--from");
  const from = fromAt >= 0 ? resolve(argv[fromAt + 1] ?? "") : null;

  const [codesCsv, metaCsv] = await Promise.all([
    readTab(from, CODES_SHEET),
    readTab(from, META_SHEET),
  ]);
  const codesById = indexById(parseCsv(codesCsv).slice(1));
  const metaById = indexById(parseCsv(metaCsv).slice(1));
  const frozen = frozenRequirements(resolve(import.meta.dir, "../data/puzzles.json"));

  const audits: Audit[] = [];
  for (const [id, codes] of [...codesById].sort(([a], [b]) => a - b)) {
    if (!codes[1]) continue; // a metadata row with no puzzle behind it yet
    const meta = metaById.get(id);
    try {
      const built = buildPuzzle(id, codes, meta);
      const requiredClears = frozen.get(id);
      audits.push(audit(requiredClears ? { ...built, requiredClears } : built));
    } catch (error) {
      audits.push({
        id,
        title: (meta?.[1] || codes[4] || `Puzzle ${id}`).trim(),
        author: (meta?.[3] || "unknown").trim(),
        verdict: "BROKEN",
        problems: [`the answer will not replay: ${(error as Error).message}`],
      });
    }
  }

  // The exit code is set before the early return, not after it: --json is the
  // mode a CI step or a sync gate would use, and it was the one mode that
  // reported success however many puzzles were broken.
  if (audits.some((a) => a.verdict === "BROKEN")) process.exitCode = 1;

  if (json) {
    console.log(JSON.stringify({ audits }, null, 1));
    return;
  }

  const broken = audits.filter((a) => a.verdict === "BROKEN");
  const goal = audits.filter((a) => a.verdict === "GOAL");
  const unreadable = audits.filter((a) => a.verdict === "UNREADABLE");
  const ok = audits.length - broken.length - goal.length - unreadable.length;
  console.log(
    `audited ${audits.length} puzzles: ${ok} OK, ${broken.length} BROKEN, ` +
      `${goal.length} with a goal that disagrees, ` +
      `${unreadable.length} whose goal cannot be machine-read\n`,
  );

  const show = (title: string, list: Audit[], note: string) => {
    if (!list.length) return;
    console.log(`${title}\n${note}\n`);
    for (const a of list) {
      console.log(`  #${a.id} "${a.title}" — ${a.author}`);
      for (const problem of a.problems) console.log(`      ${problem}`);
    }
    console.log();
  };

  show(
    `BROKEN (${broken.length}) — nobody can solve these as specified`,
    broken,
    "  Either the recorded answer does not replay at all, or it replays and still\n" +
      "  fails the puzzle's own solve condition. A player who reproduces the intended\n" +
      "  line exactly would be told they failed.",
  );
  show(
    `GOAL DISAGREES (${goal.length}) — solvable, but the written goal is wrong`,
    goal,
    "  Players are judged on the frozen clear requirement, not on the prose, so these\n" +
      "  are playable. The goal text asks for something the intended answer does not do,\n" +
      "  which misleads the player and is how a requirement gets frozen wrong later.",
  );

  if (unreadable.length) {
    console.log(
      `GOAL NOT MACHINE-READABLE (${unreadable.length}) — a human has to check these\n` +
        "  The answer replays and meets every requirement on file, but the goal is\n" +
        "  written in prose no parser here understands (\"Chain 3 attacks: TSS>D>D.\",\n" +
        "  \"Clear a TST and a DT\"), so nothing has checked that the answer does what\n" +
        "  the goal asks. They are not known-bad; they are unverified.\n",
    );
    console.log(
      unreadable.map((a) => `  #${a.id} "${a.title}" — ${a.author}: goal ${JSON.stringify(a.goal)}`).join("\n"),
    );
    console.log();
  }

}

if (import.meta.main) {
  await main();
}
