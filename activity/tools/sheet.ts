/**
 * Reading a tab of the club's puzzle archive spreadsheet.
 *
 * One implementation, because there were two and they drifted: the sync grew a
 * guard against the sheet answering with a sign-in page, the audit was written
 * later by copying the function without it, and the audit is the tool whose
 * whole job is to notice when something is wrong. A checker that reports
 * everything fine because it read nothing is worse than no checker.
 *
 * The document is world-readable, so `gviz` exports a tab as CSV with no
 * credentials and nothing to configure.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CODES_SHEET, META_SHEET } from "./decode-archive";

/** The published sheet. Its id is not a secret; the document is world-readable. */
export const SHEET_ID = "1OUA3w3Q1OAajaNLlp74CwrZhnBKRbkeo4hYux_v94QM";

/** The tab name behind each of the build script's two filenames. */
export const TAB_OF: Readonly<Record<string, string>> = {
  [CODES_SHEET]: "blueprint urls",
  [META_SHEET]: "Puzzles",
};

function tabUrl(tab: string): string {
  return (
    `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq` +
    `?tqx=out:csv&sheet=${encodeURIComponent(tab)}`
  );
}

/**
 * One tab, as CSV text. From `from` when given, otherwise from the sheet.
 *
 * Three things can go wrong and only one of them is an HTTP error.
 *
 * A sheet that stops being publicly readable answers **200 with a sign-in
 * page**, so the status alone is not enough — hence the HTML check.
 *
 * A tab that has been renamed is worse: `gviz` answers 200 with **the first
 * tab's CSV**, which is well-formed CSV of entirely the wrong data. Nothing
 * here can tell that apart from the real thing, which is why both callers have
 * to treat "I parsed zero puzzles" as a failure rather than as an empty
 * archive. This function cannot do it for them.
 */
export async function readSheetTab(from: string | null, sheet: string): Promise<string> {
  if (from) return readFileSync(join(from, sheet), "utf8");

  const tab = TAB_OF[sheet];
  if (!tab) throw new Error(`No tab known for ${sheet}`);
  const response = await fetch(tabUrl(tab));
  if (!response.ok) throw new Error(`Sheet tab "${tab}" answered ${response.status}`);

  const body = await response.text();
  if (body.trimStart().startsWith("<")) {
    throw new Error(
      `Sheet tab "${tab}" returned HTML, not CSV — the document is probably no ` +
        "longer shared with anyone who has the link.",
    );
  }
  return body;
}
