/**
 * The maker-facing detail view: every line on record for one puzzle.
 *
 * It shipped answering 400 to every request. `idParam` reads the route segment
 * called `id` and takes its `named` argument only for the refusal text, so a
 * route declaring `:puzzle` — the only one in the file that did — read
 * undefined and refused itself. Nothing caught it because nothing called it:
 * this file is the test that did not exist.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppRouter, Variables } from "../server/http";
import type { Store } from "../server/db";
import type { Puzzle } from "../shared/puzzle";

const SECRET = "review-solutions-secret";
const BASE = "https://local.test";
const SHARED_DB = join(tmpdir(), `puzzle-routes-${process.pid}.sqlite`);

let StoreClass: typeof import("../server/db").Store;
let registerReviewRoutes: typeof import("../server/review-routes").registerReviewRoutes;
let apiError: typeof import("../server/http").apiError;
let mintReviewToken: typeof import("../server/review-token").mintReviewToken;

const PUZZLE = {
  id: 4242,
  title: "under review",
  author: "someone",
  difficulty: 4,
  goal: "Clear a TSD",
  set: null,
  board: ["GGGGGGGGG."],
  queue: ["T"],
  hold: null,
  targetAttack: 4,
} as unknown as Puzzle;

beforeAll(async () => {
  process.env.DATABASE_PATH = SHARED_DB;
  process.env.ALLOW_GUEST_PLAY = "true";
  process.env.NODE_ENV = "test";
  ({ Store: StoreClass } = await import("../server/db"));
  ({ registerReviewRoutes } = await import("../server/review-routes"));
  ({ apiError } = await import("../server/http"));
  ({ mintReviewToken } = await import("../server/review-token"));
});

function reviewApp(store: Store): AppRouter {
  const app = new Hono<{ Variables: Variables }>();
  app.onError(apiError);
  registerReviewRoutes(app, {
    secret: SECRET,
    store,
    archive: {
      originals: [PUZZLE],
      original: (id: number) => (id === PUZZLE.id ? PUZZLE : undefined),
      correctionsApplied: true,
    } as never,
  });
  return app;
}

async function ask(path: string): Promise<Response> {
  const store = new StoreClass(SHARED_DB);
  try {
    const bearer = await mintReviewToken(SECRET, "hannah");
    return await reviewApp(store).fetch(
      new Request(`${BASE}${path}`, { headers: { Authorization: `Bearer ${bearer}` } }),
    );
  } finally {
    store.close();
  }
}

describe("the lines on record for one puzzle", () => {
  test("the route can be called at all", async () => {
    // The whole finding: it answered 400 to every request, because it declared
    // its parameter as `:puzzle` while `idParam` reads `id`.
    const response = await ask(`/api/review/puzzles/${PUZZLE.id}/solutions`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { puzzleId: number; solutions: unknown[] };
    expect(body.puzzleId).toBe(PUZZLE.id);
    expect(Array.isArray(body.solutions)).toBe(true);
  });

  test("it answers with the goal and the rule the maker is judging against", async () => {
    const body = (await (await ask(`/api/review/puzzles/${PUZZLE.id}/solutions`)).json()) as {
      goal: string;
      targetAttack: number;
    };

    expect(body.goal).toBe(PUZZLE.goal);
    expect(body.targetAttack).toBe(PUZZLE.targetAttack);
  });

  test("a puzzle the archive does not hold is a 404, not a 400", async () => {
    // The refusal that means "no such puzzle" has to stay distinguishable from
    // the one that means "that is not a number" — which is what a mis-declared
    // parameter turned every request into.
    expect((await ask("/api/review/puzzles/999999/solutions")).status).toBe(404);
  });

  test("and a non-numeric id is still the 400", async () => {
    expect((await ask("/api/review/puzzles/banana/solutions")).status).toBe(400);
  });

  test("it needs a reviewer", async () => {
    const store = new StoreClass(SHARED_DB);
    try {
      const response = await reviewApp(store).fetch(
        new Request(`${BASE}/api/review/puzzles/${PUZZLE.id}/solutions`),
      );
      expect(response.status).toBe(401);
    } finally {
      store.close();
    }
  });
});
