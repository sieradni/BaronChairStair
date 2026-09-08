/**
 * The answers that ship with the repository.
 *
 * `data/solutions.json` is untracked, so on every ordinary deploy the served
 * puzzles arrive with no answer: the reveal after a solve has nothing to show,
 * the duel reveal is empty, and the reference solutions that stop a first solver
 * being credited with a discovery cannot be seeded. Production is exactly that
 * box.
 *
 * The answers are not missing from it. All of them are committed inside
 * `data/archive/puzzles.sqlite`, which every checkout has and which
 * `tests/tracked-archive.test.ts` already guards. This reads them back.
 *
 * **Keyed by shape, not by id.** See `shapeKey` — the archive and
 * `data/puzzles.json` have drifted on three of 138 puzzles, and an id join would
 * put another puzzle's answer behind this one's reveal.
 *
 * Read-only and forgiving: a missing or unreadable file costs exactly what it
 * cost before this existed, which is the reveal and nothing else. The server
 * must still boot for everybody.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { shapeKey } from "./puzzles";
import type { RowCode, SolutionStep } from "../shared/puzzle";

interface Row {
  board: string;
  queue: string;
  hold: string | null;
  target_attack: number;
  solution: string | null;
}

/** Every answer the tracked archive holds, keyed by the shape it was played against. */
export function trackedAnswers(path: string): Map<string, readonly SolutionStep[]> {
  const answers = new Map<string, readonly SolutionStep[]>();
  if (!existsSync(path)) return answers;

  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    const rows = db
      .query<Row, []>(
        "SELECT board, queue, hold, target_attack, solution FROM archive_puzzles",
      )
      .all();
    for (const row of rows) {
      if (!row.solution) continue;
      const solution = JSON.parse(row.solution) as SolutionStep[];
      if (!Array.isArray(solution) || solution.length === 0) continue;
      const key = shapeKey({
        board: JSON.parse(row.board) as RowCode[],
        queue: JSON.parse(row.queue) as string[],
        hold: row.hold,
        targetAttack: row.target_attack,
      } as Parameters<typeof shapeKey>[0]);
      // First writer wins. Two rows with the same shape are the same puzzle by
      // every measure that matters here, so the second is not a second answer.
      if (!answers.has(key)) answers.set(key, solution);
    }
  } catch (error) {
    // A corrupt or older archive costs the reveal, never the boot.
    console.warn(`[puzzle] could not read answers from ${path}: ${String(error)}`);
  } finally {
    db?.close();
  }
  return answers;
}
