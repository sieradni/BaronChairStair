/**
 * The selection model, pinned.
 *
 * sheet.css states it once on `.sheet`: nothing on the page selects by
 * default; text meant to be read asks back in with `.selectable`; form
 * fields opt themselves in; and while a live run is up, the deck's marker
 * silences even the ask-back-ins (a drift across the goal sentence mid-drag
 * must not paint a highlight and eat the move stream).
 *
 * Two things can break that model silently. A CSS edit that moves a rule off
 * the root (the pre-inversion bug class: furniture kept highlighting because
 * each surface carried its own opt-out and the next one was missed) — and a
 * sixth child in App.mount(), which would sit outside every rule written so
 * far for exactly the same reason the credits strip once did. The first the
 * cascade below catches; the second the inventory pin catches, by name.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";

let window: Window;
const saved = {
  document: globalThis.document,
  getComputedStyle: globalThis.getComputedStyle,
};

beforeAll(() => {
  // The global swap is the pattern render.test.ts uses: lending happy-dom's
  // document to the test file so every createElement is typed like the app's
  // own, and restored afterwards because `bun test` shares one process.
  window = new Window({ url: "https://local.test/" });
  globalThis.document = window.document as unknown as Document;
  globalThis.getComputedStyle = window.getComputedStyle.bind(window) as unknown as
    typeof getComputedStyle;
  // The app's sheets, in the order the front door loads them (render.test.ts
  // documents why order matters; only sheet.css carries selection rules, but
  // the cascade these tests read should be the cascade that ships).
  for (const sheet of [
    "client/src/styles/panels.css",
    "client/src/styles/home.css",
    "client/src/styles/overlays.css",
    "client/src/styles/sheet.css",
  ]) {
    const style = document.createElement("style");
    style.textContent = readFileSync(sheet, "utf8");
    document.head.append(style);
  }
});

afterEach(() => {
  document.body.replaceChildren();
});

afterAll(async () => {
  globalThis.document = saved.document;
  globalThis.getComputedStyle = saved.getComputedStyle;
  // happy-dom holds timers, observers and the whole tree until it is told to
  // stop; without this the process has no reason to exit.
  await window.happyDOM.close();
});

/** The probes the assertions read, one per region of the model. */
interface Page {
  mastheadMark: HTMLElement;
  liveGoal: HTMLElement;
  calmGoal: HTMLElement;
  plain: HTMLElement;
  walkthrough: HTMLElement;
  deckInput: HTMLInputElement;
  creditsTitle: HTMLElement;
  spec: HTMLElement;
  specInput: HTMLInputElement;
  toast: HTMLElement;
  bareInput: HTMLInputElement;
}

/** Mounts the page's five children with one probe inside each region. */
function mountPage(): Page {
  const doc = document;
  const make = (tag: string, cls: string, text = ""): HTMLElement => {
    const node = doc.createElement(tag);
    node.className = cls;
    if (text) node.textContent = text;
    return node;
  };

  const mastheadMark = make("span", "masthead__mark", "Puzzle");
  const liveGoal = make("p", "goal__text selectable", "Clear a Quad");
  const calmGoal = make("p", "goal__text selectable", "Clear a Quad");
  const plain = make("p", "hud__note", "progress note");
  const walkthrough = make("div", "solutions selectable", "how it was solved");
  const deckInput = doc.createElement("input");
  const creditsTitle = make("span", "credits__title", "cave diver 2");
  const spec = make("div", "spec selectable");
  const specInput = doc.createElement("input");
  spec.append(specInput);
  const toast = make("div", "toast", "Nothing to undo");

  const liveDeck = make("div", "deck deck--play deck--gestures");
  liveDeck.append(liveGoal, plain);
  const calmDeck = make("div", "deck deck--screen");
  calmDeck.append(calmGoal, walkthrough, deckInput);

  const sheet = make("div", "sheet");
  sheet.append(
    make("header", "masthead"), // .masthead itself carries the wordmark child
    liveDeck,
    calmDeck,
    make("footer", "credits"),
    spec,
    toast,
  );
  sheet.querySelector(".masthead")!.append(mastheadMark);
  sheet.querySelector(".credits")!.append(creditsTitle);
  doc.body.append(sheet);

  const bareInput = doc.createElement("input");
  doc.body.append(bareInput);

  return {
    mastheadMark,
    liveGoal,
    calmGoal,
    plain,
    walkthrough,
    deckInput,
    creditsTitle,
    spec,
    specInput,
    toast,
    bareInput,
  } as Page;
}

function userSelect(node: HTMLElement): string {
  return getComputedStyle(node).userSelect;
}

/**
 * The `user-select` values of every stylesheet rule that matches `node`
 * directly. happy-dom resolves a computed `user-select` only from a direct
 * match — it does not perform the spec's `auto` → parent-used-value
 * resolution a real browser applies — so the furniture probes below assert
 * the thing that matters at the source: no rule names them, and they inherit
 * the sheet's `none` the way the model intends.
 */
function directSelectionRules(node: HTMLElement): string[] {
  const values: string[] = [];
  for (const sheet of document.styleSheets) {
    for (const rule of Array.from((sheet as CSSStyleSheet).cssRules)) {
      // Duck-typed rather than `instanceof CSSStyleRule`: happy-dom defines
      // its own rule classes that are not the globals a real window exposes.
      const style = (rule as CSSStyleRule).style;
      const selector = (rule as CSSStyleRule).selectorText;
      if (!style || typeof selector !== "string") continue;
      try {
        if (node.matches(selector) && style.getPropertyValue("user-select")) {
          values.push(style.getPropertyValue("user-select"));
        }
      } catch {
        // A selector happy-dom cannot parse is not a selection rule.
      }
    }
  }
  return values;
}

describe("the sheet-level selection model", () => {
  test("the sheet opts everything out at the root", () => {
    const page = mountPage();
    const sheet = page.mastheadMark.closest(".sheet")! as HTMLElement;
    expect(userSelect(sheet)).toBe("none");
  });

  test("no per-element rule names the furniture — they inherit the root's none", () => {
    // The pre-inversion bug class: each surface carried its own opt-out and
    // the next piece of furniture was missed. If any rule starts naming the
    // masthead, the credits strip or the toast again, this names it first.
    const page = mountPage();
    expect(directSelectionRules(page.mastheadMark)).toEqual([]);
    expect(directSelectionRules(page.creditsTitle)).toEqual([]);
    expect(directSelectionRules(page.toast)).toEqual([]);
    expect(directSelectionRules(page.plain)).toEqual([]);
  });

  test("reading surfaces ask back in with .selectable", () => {
    const page = mountPage();
    expect(userSelect(page.calmGoal)).toBe("text");
    expect(userSelect(page.walkthrough)).toBe("text");
    expect(userSelect(page.spec)).toBe("text");
  });

  test("a live run silences even the ask-back-ins on the deck", () => {
    const page = mountPage();
    expect(userSelect(page.liveGoal)).toBe("none");
  });

  test("form fields keep their text wherever they sit", () => {
    const page = mountPage();
    expect(userSelect(page.deckInput)).toBe("text");
    expect(userSelect(page.specInput)).toBe("text");
    expect(userSelect(page.bareInput)).toBe("text");
  });

  test("App.mount() mounts exactly the children the model was written for", () => {
    // The sheet-level rule covers the page by covering its children; a sixth
    // child would sit outside every decision made here. This names the set
    // the model relies on so adding to it is a conscious act, not a miss the
    // way the credits strip once was.
    const source = readFileSync("client/src/app.ts", "utf8");
    const mountCall = source.match(/replaceChildren\(\s*this\.root,([\s\S]*?)\)\s*;/);
    expect(mountCall).not.toBeNull();
    const mountBody = mountCall![1];
    expect(mountBody).toBeTruthy();
    const children = [...(mountBody as string).matchAll(/this\.(\w+)(?:\.element)?/g)].map(
      (match) => match[1],
    );
    expect(children).toEqual([
      "masthead",
      "deck",
      "credits",
      "settingsDialog",
      "toastNode",
    ]);
  });
});
