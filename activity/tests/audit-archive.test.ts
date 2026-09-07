/**
 * The audit, on the three real rows in the fixture.
 *
 * #13's recorded answer will not replay, so it must be flagged; #1 and #2
 * replay and meet their requirements, so they must not be. The point of testing
 * against real sheet rows rather than constructed ones is that the failure in
 * #13 is a real maker's real mistake, in the shape the tool has to catch.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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

describe("when the sheet cannot be read", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "audit-badsheet-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function sheetOf(body: string): string {
    for (const name of [
      "Copy of Puzzles Archive - blueprint urls.csv",
      "Copy of Puzzles Archive - Puzzles.csv",
    ]) {
      writeFileSync(join(dir, name), body);
    }
    return dir;
  }

  async function audit(from: string): Promise<{ code: number; out: string }> {
    const proc = Bun.spawn(["bun", "run", TOOL, "--from", from, "--json"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code: await proc.exited, out: out + err };
  }

  test("a sign-in page is a failure, not an all-clear", async () => {
    const { code, out } = await audit(sheetOf("<!DOCTYPE html><html><body>Sign in</body></html>"));

    expect(code).not.toBe(0);
    expect(out).toContain("audited 0 puzzles");
  });

  test("another tab's well-formed CSV is a failure too", async () => {
    // The nastier shape: a renamed tab makes gviz answer 200 with the FIRST
    // tab's CSV. It is valid CSV of entirely the wrong data, so no guard in the
    // reader can tell — only "I parsed no puzzles" catches it.
    const { code, out } = await audit(sheetOf("notes,about\nthis sheet,is documentation\n"));

    expect(code).not.toBe(0);
    expect(out).toContain("audited 0 puzzles");
  });

  test("and the real fixture still audits clean", async () => {
    const { audits } = await auditFixture();

    expect(audits.length).toBeGreaterThan(0);
  });
});
