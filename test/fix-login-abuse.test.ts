import "./env.ts";
import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { app } from "../server/http/app.js";
import {
  checkPasswordLimited,
  isLocalRequest,
  LOGIN_LIMITS,
  loginAllowed,
  loginSucceeded,
  SETUP_TOKEN,
  trackedLoginAttempts,
} from "../server/http/auth.js";
import { hashPassword } from "../server/core/secrets.js";
import { fakeReq } from "./helpers.ts";

/**
 * Review 2026-11-02, item 4: login requests can't pin memory with huge usernames, changing the username doesn't reset
 * the throttle, the throttle table is bounded, and scrypt runs a bounded number of times at once.
 */

const defaults = { ...LOGIN_LIMITS };
afterEach(() => {
  Object.assign(LOGIN_LIMITS, defaults);
  delete process.env.TASTEARR_LOCAL_NETWORKS;
});

before(async () => {
  await app.ready();
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/setup",
    remoteAddress: "203.0.113.1",
    headers: { host: "192.168.1.5:8383", "x-tastearr": "1" },
    payload: { username: "owner", password: "correct horse", setupToken: SETUP_TOKEN },
  });
  assert.equal(res.statusCode, 200);
});
after(async () => {
  await app.close();
});

const login = (ip: string, username: unknown, password: unknown = "wrong password") =>
  app.inject({
    method: "POST",
    url: "/api/auth/login",
    remoteAddress: ip,
    headers: { host: "192.168.1.5:8383", "x-tastearr": "1" },
    payload: { username, password },
  });

test("an over-long username or password is refused (400) before the throttle records anything", async () => {
  const before = trackedLoginAttempts();
  const res = await login("203.0.113.50", "u".repeat(LOGIN_LIMITS.maxUser + 1));
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /at most 128 characters/);
  assert.equal((await login("203.0.113.50", "owner", "p".repeat(LOGIN_LIMITS.maxPassword + 1))).statusCode, 400);
  assert.equal(trackedLoginAttempts(), before, "nothing stored for the refused requests");
  assert.equal((await login("203.0.113.50", "owner", "correct horse")).statusCode, 200, "normal logins still work");
});

test("a body far over the auth limit is refused without being parsed", async () => {
  const res = await login("203.0.113.51", "x".repeat(20_000));
  assert.equal(res.statusCode, 413);
});

test("changing the username on every try doesn't reset the throttle: names past the first few share one bucket", () => {
  const ip = "198.51.100.7";
  let allowed = 0;
  for (let i = 0; i < 40; i++) if (loginAllowed(ip, `user${i}`)) allowed++;
  // One try each for the names with their own entry, then the shared bucket's free tries and the one that starts its back-off.
  assert.equal(allowed, LOGIN_LIMITS.namesPerIp + LOGIN_LIMITS.perUser + 1);
  assert.equal(loginAllowed("198.51.100.8", "user0"), true, "another IP is unaffected");
  assert.equal(loginAllowed(ip, "owner"), true, "the account's own name keeps its own entry (review #3)");
  loginSucceeded(ip, "owner");
});

test("the same username from one IP still backs off after its own free tries", () => {
  const ip = "198.51.100.9";
  for (let i = 0; i < LOGIN_LIMITS.perUser; i++) assert.equal(loginAllowed(ip, "owner"), true);
  assert.equal(loginAllowed(ip, "owner"), true, "the try that starts the back-off");
  assert.equal(loginAllowed(ip, "owner"), false);
});

test("the throttle table stays bounded under a flood of new IPs and usernames", () => {
  LOGIN_LIMITS.maxTracked = 50;
  for (let i = 0; i < 500; i++) loginAllowed(`10.9.${i >> 8}.${i & 255}`, `name-${i}`);
  assert.ok(trackedLoginAttempts() <= 50, `tracked ${trackedLoginAttempts()}`);
});

test("password checks run at most scryptSlots at once; a full queue is a 429 instead of more CPU", async () => {
  LOGIN_LIMITS.scryptSlots = 1;
  LOGIN_LIMITS.scryptQueue = 1;
  const stored = await hashPassword("secret password");
  const results = await Promise.allSettled([
    checkPasswordLimited("secret password", stored),
    checkPasswordLimited("nope", stored),
    checkPasswordLimited("nope", stored),
  ]);
  assert.equal(results[0].status === "fulfilled" && results[0].value, true);
  assert.equal(results[1].status === "fulfilled" && results[1].value, false);
  assert.equal(results[2].status, "rejected");
  assert.equal((results[2] as PromiseRejectedResult).reason.statusCode, 429);
  // The slots are all given back: later checks run normally.
  assert.equal(await checkPasswordLimited("secret password", stored), true);
  assert.equal(await checkPasswordLimited("secret password", stored), true);
});

test("local-network rules: Docker's 172.16/12 and loopback are never local, even when listed in TASTEARR_LOCAL_NETWORKS for loopback", () => {
  assert.equal(isLocalRequest(fakeReq({ ip: "172.17.0.1" })), false);
  assert.equal(isLocalRequest(fakeReq({ ip: "::ffff:172.17.0.1" })), false);
  assert.equal(isLocalRequest(fakeReq({ ip: "127.0.0.1" })), false);
  assert.equal(isLocalRequest(fakeReq({ ip: "::1" })), false);
  process.env.TASTEARR_LOCAL_NETWORKS = "127.0.0.0/8";
  assert.equal(isLocalRequest(fakeReq({ ip: "127.0.0.1" })), false, "a loopback peer is a proxy or tunnel on the host");
});
