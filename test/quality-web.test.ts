import "./env.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { errorMessage } from "../web/src/lib/errors.ts";
import { trapTarget } from "../web/src/lib/focus.ts";
import { pollUntil } from "../web/src/lib/poll.ts";
import { currentSeason, readPicksQuery } from "../web/src/picks/query.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("pollUntil keeps polling until the result is final", async () => {
  const seen: number[] = [];
  let n = 0;
  pollUntil({
    step: async () => ++n,
    keepGoing: (v) => v < 3,
    onResult: (v) => seen.push(v),
    onError: () => assert.fail("no error expected"),
    delayMs: 5,
    firstDelayMs: 1,
  });
  await sleep(80);
  assert.deepEqual(seen, [1, 2, 3]);
});

test("pollUntil stops for good when cancelled, even with a request in flight or a timer pending", async () => {
  let calls = 0;
  const seen: number[] = [];
  const stop = pollUntil({
    step: async () => {
      calls++;
      await sleep(20);
      return calls;
    },
    keepGoing: () => true,
    onResult: (v) => seen.push(v),
    onError: () => undefined,
    delayMs: 5,
    firstDelayMs: 1,
  });
  await sleep(10); // first request is in flight
  stop();
  await sleep(80);
  assert.equal(calls, 1);
  assert.deepEqual(seen, [], "a result that arrives after cancelling is dropped");

  let late = 0;
  const stopEarly = pollUntil({
    step: async () => ++late,
    keepGoing: () => true,
    onResult: () => undefined,
    onError: () => undefined,
    delayMs: 5,
    firstDelayMs: 30,
  });
  stopEarly();
  await sleep(60);
  assert.equal(late, 0, "cancelled before the first call");
});

test("pollUntil reports a failed step once and stops", async () => {
  const errors: unknown[] = [];
  let calls = 0;
  pollUntil({
    step: async () => {
      calls++;
      throw new Error("boom");
    },
    keepGoing: () => true,
    onResult: () => undefined,
    onError: (e) => errors.push(e),
    delayMs: 5,
    firstDelayMs: 1,
  });
  await sleep(40);
  assert.equal(calls, 1);
  assert.equal(errors.length, 1);
});

test("readPicksQuery uses the URL season, else the server's, else today's - never a missing value", () => {
  const now = new Date(2031, 4, 10);
  assert.deepEqual(readPicksQuery("?season=fall&year=2030", {}, "grid", now).sel, { season: "FALL", year: 2030 });
  assert.deepEqual(readPicksQuery("", { season: { season: "WINTER", year: 2032 } }, "grid", now).sel, { season: "WINTER", year: 2032 });
  assert.deepEqual(readPicksQuery("", {}, "grid", now).sel, { season: "SPRING", year: 2031 });
  assert.deepEqual(readPicksQuery("?season=nonsense&year=2030", {}, "grid", now).sel, currentSeason(now));
  assert.deepEqual(currentSeason(new Date(2031, 11, 31)), { season: "FALL", year: 2031 });
});

test("readPicksQuery reads view and day, falling back to the stored view", () => {
  const r = readPicksQuery("?view=schedule&day=0", {}, "grid");
  assert.equal(r.view, "schedule");
  assert.equal(r.day, 0);
  assert.equal(readPicksQuery("?day=", {}, "schedule").view, "schedule");
  assert.equal(readPicksQuery("?day=", {}, "schedule").day, null);
  assert.equal(readPicksQuery("?view=bogus", {}, "grid").view, "grid");
});

test("trapTarget keeps Tab inside a dialog, including one with a single control", () => {
  const [a, b, c] = ["a", "b", "c"];
  assert.equal(trapTarget([a, b, c], c, false), a, "Tab on the last wraps to the first");
  assert.equal(trapTarget([a, b, c], a, true), c, "Shift+Tab on the first wraps to the last");
  assert.equal(trapTarget([a, b, c], b, false), null, "in the middle the browser decides");
  assert.equal(trapTarget([a, b, c], "outside", false), a, "lost focus comes back in");
  assert.equal(trapTarget([a], a, false), a, "one control: Tab stays on it");
  assert.equal(trapTarget([a], a, true), a, "one control: Shift+Tab stays on it");
  assert.equal(trapTarget([], "x", false), null, "nothing to focus: leave it alone");
});

test("errorMessage reads Errors and tolerates anything else", () => {
  assert.equal(errorMessage(new Error("bad")), "bad");
  assert.equal(errorMessage("text"), "text");
  assert.equal(errorMessage(undefined), "undefined");
});
