import "./env.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { app } from "../server/http/app.js";
import { LOGIN_LIMITS, loginAllowed, SETUP_TOKEN } from "../server/http/auth.js";

/**
 * AnimeArr auth review B4, ported: the owner's reserved password-check lane was picked by the user name in the request.
 * The user name is guessable, so a flood naming the real user from many addresses filled that lane and the real owner,
 * with the right password, got 429. A browser that logged in before carries a signed "known device" cookie and gets
 * its own throttle entry and its own lane.
 */

const HOST = { host: "192.168.1.5:8383", "x-tastearr": "1" };
let deviceCookie = "";

before(async () => {
  await app.ready();
  const setup = await app.inject({
    method: "POST",
    url: "/api/auth/setup",
    remoteAddress: "203.0.113.1",
    headers: HOST,
    payload: { username: "owner", password: "correct horse", setupToken: SETUP_TOKEN },
  });
  assert.equal(setup.statusCode, 200);
  // The owner's browser logs in once, normally.
  const first = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    remoteAddress: "198.51.100.10",
    headers: HOST,
    payload: { username: "owner", password: "correct horse" },
  });
  assert.equal(first.statusCode, 200);
  deviceCookie = first.cookies
    .filter((c) => c.name !== "tastearr_session")
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
});
after(async () => {
  await app.close();
});

const login = (ip: string, password: string, cookie = "") =>
  app.inject({
    method: "POST",
    url: "/api/auth/login",
    remoteAddress: ip,
    headers: { ...HOST, ...(cookie ? { cookie } : {}) },
    payload: { username: "owner", password },
  });

test("30 concurrent logins naming the real user from 30 addresses don't refuse the real owner's browser", async () => {
  const flood = Array.from({ length: 30 }, (_, i) => login(`203.0.113.${100 + i}`, `guess ${i}`));
  const owner = login("198.51.100.10", "correct horse", deviceCookie);
  const results = await Promise.all([...flood, owner]);
  const codes = results.slice(0, 30).map((r) => r.statusCode);
  assert.ok(codes.includes(429), `the flood fills the queue (${[...new Set(codes)]})`);
  assert.equal(results[30].statusCode, 200, `the owner gets in: ${results[30].body}`);
});

test("behind one proxy address, guessing the real user's password doesn't throttle the owner's known browser", async () => {
  const proxy = "10.0.0.9";
  for (let i = 0; i < 8; i++) await login(proxy, `wrong ${i}`);
  assert.equal((await login(proxy, "correct horse")).statusCode, 429, "an unknown browser behind the proxy is throttled");
  assert.equal((await login(proxy, "correct horse", deviceCookie)).statusCode, 200, "the owner's known browser is not");
});

test("a forged or tampered device cookie counts as no cookie", async () => {
  const proxy = "10.0.0.10";
  for (let i = 0; i < 8; i++) await login(proxy, `wrong ${i}`);
  const forged = deviceCookie.replace(/=([^.]*)\./, "=AAAAAAAAAAAA.");
  assert.equal((await login(proxy, "correct horse", forged)).statusCode, 429);
  assert.equal((await login(proxy, "correct horse", "tastearr_device=made.up.value")).statusCode, 429);
});

test("AnimeArr review A3: a full throttle table never refuses a new client (the oldest entries make room)", () => {
  const max = LOGIN_LIMITS.maxTracked;
  LOGIN_LIMITS.maxTracked = 20;
  try {
    for (let i = 0; i < 200; i++) loginAllowed(`192.0.2.${i}`, `junk${i}`);
    assert.equal(loginAllowed("198.51.100.77", "owner"), true, "a client never seen before");
  } finally {
    LOGIN_LIMITS.maxTracked = max;
  }
});
