/**
 * The audit, on the three real rows in the fixture.
 *
 * #13's recorded answer will not replay, so it must be flagged; #1 and #2
 * replay and meet their requirements, so they must not be. The point of testing
 * against real sheet rows rather than constructed ones is that the failure in
 * #13 is a real maker's real mistake, in the shape the tool has to catch.
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const TOOL = resolve(import.meta.dir, "../tools/audit-archive.ts");
const SHEET = resolve(import.meta.dir, "fixtures/archive-sheet");

interface Audit {
  id: number;
  verdict: "BROKEN" | "GOAL" | "UNREADABLE" | "OK";
  problems: string[];
}

async function auditFixture(): Promise<{ code: number; audits: Audit[] }> {
  const proc = Bun.spawn(["bun", "run", TOOL, "--from", SHEET, "--json"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { code, audits: (JSON.parse(out) as { audits: Audit[] }).audits };
}

describe("auditing the archive", () => {
  test("flags the puzzle whose recorded answer will not replay", async () => {
    const { code, audits } = await auditFixture();

    const thirteen = audits.find((a) => a.id === 13);
    expect(thirteen?.verdict).toBe("BROKEN");
    expect(thirteen?.problems[0]).toContain("will not replay");
    // Non-zero, so this can gate a sync or a CI step rather than being read.
    expect(code).toBe(1);
  });

  test("does not flag the puzzles whose answers are sound", async () => {
    const { audits } = await auditFixture();

    for (const id of [1, 2]) {
      expect(audits.find((a) => a.id === id)?.verdict).not.toBe("BROKEN");
    }
  });

  test("reports every puzzle on the sheet, sound or not", async () => {
    const { audits } = await auditFixture();

    expect(audits.map((a) => a.id).sort((a, b) => a - b)).toEqual([1, 2, 13]);
  });
});
