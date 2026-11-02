import "./env.ts";
import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { hashPassword } from "../server/core/secrets.js";
import { app } from "../server/http/app.js";
import { checkPasswordLimited, LOGIN_LIMITS, loginAllowed, SETUP_TOKEN, trackedLoginAttempts } from "../server/http/auth.js";

/**
 * Fix-branch review #3 and #5: behind a proxy without TRUST_PROXY every client shares one address. Junk logins from it
 * must not lock the owner out: each IP gets its own throttle entry for a few user names, further names share one
 * throttled bucket, and the account's own user name always keeps its own entry. The owner's password check has a
 * reserved slot, so a flood that fills the check queue can't refuse it either. A proxy without TRUST_PROXY is logged.
 */

const PROXY = "10.0.0.1";
const defaults = { ...LOGIN_LIMITS };
afterEach(() => void Object.assign(LOGIN_LIMITS, defaults));

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

const login = (ip: string, username: string, password: string) =>
  app.inject({
    method: "POST",
    url: "/api/auth/login",
    remoteAddress: ip,
    headers: { host: "192.168.1.5:8383", "x-tastearr": "1" },
    payload: { username, password },
  });

test("junk logins with made-up user names from the shared proxy address don't lock the owner out", async () => {
  const codes = new Set<number>();
  for (let i = 0; i < 40; i++) codes.add((await login(PROXY, `junk${i}`, "guess")).statusCode);
  assert.ok(codes.has(429), "the junk flood itself is throttled");
  const res = await login(PROXY, "owner", "correct horse");
  assert.equal(res.statusCode, 200, `the owner gets in: ${res.body}`);
});

test("the owner's own user name is still throttled when it is the one being guessed", async () => {
  const ip = "10.0.0.2";
  for (let i = 0; i <= LOGIN_LIMITS.perUser; i++) assert.equal((await login(ip, "owner", "wrong")).statusCode, 401);
  assert.equal((await login(ip, "owner", "correct horse")).statusCode, 429, "brute force on the real name still backs off");
});

test("one address gets its own entry for a few names; further names share one throttled bucket (memory stays bounded)", () => {
  const ip = "10.0.0.3";
  const before = trackedLoginAttempts();
  let allowed = 0;
  for (let i = 0; i < 100; i++) if (loginAllowed(ip, `name${i}`)) allowed++;
  assert.equal(trackedLoginAttempts() - before, LOGIN_LIMITS.namesPerIp + 1, "own entries plus the shared bucket");
  assert.equal(allowed, LOGIN_LIMITS.namesPerIp + LOGIN_LIMITS.perUser + 1, "the shared bucket backs off like one name");
  assert.equal(loginAllowed(ip, "owner"), true, "the account's own name is never put in the shared bucket");
});

test("a flood that fills the password-check queue doesn't refuse the owner's check (reserved slot)", async () => {
  Object.assign(LOGIN_LIMITS, { scryptSlots: 1, scryptQueue: 1 });
  const stored = await hashPassword("correct horse");
  const junk = [checkPasswordLimited("a", stored), checkPasswordLimited("b", stored), checkPasswordLimited("c", stored)];
  const owner = checkPasswordLimited("correct horse", stored, true);
  const [r1, r2, r3] = await Promise.allSettled(junk);
  assert.equal(r1.status, "fulfilled");
  assert.equal(r2.status, "fulfilled");
  assert.equal(r3.status === "rejected" && (r3.reason as { statusCode?: number }).statusCode, 429, "junk past the queue is refused");
  assert.equal(await owner, true, "the owner's check ran");
});

test("the owner's lane has its own queue limit, so a flood naming the real user still can't grow it without bound", async () => {
  Object.assign(LOGIN_LIMITS, { scryptQueue: 1 });
  const stored = await hashPassword("correct horse");
  const r = await Promise.allSettled([1, 2, 3].map(() => checkPasswordLimited("wrong", stored, true)));
  assert.deepEqual(
    r.map((x) => x.status),
    ["fulfilled", "fulfilled", "rejected"],
  );
});

test("a request through a proxy while TRUST_PROXY isn't set logs a warning once: every client looks like one address", async () => {
  const warn = console.warn;
  const logged: string[] = [];
  console.warn = (...a: unknown[]) => void logged.push(a.join(" "));
  try {
    const status = () =>
      app.inject({
        method: "GET",
        url: "/api/status",
        remoteAddress: "192.168.1.2",
        headers: { host: "192.168.1.5:8383", "x-forwarded-for": "198.51.100.4" },
      });
    await status();
    await status();
  } finally {
    console.warn = warn;
  }
  const hits = logged.filter((m) => /TRUST_PROXY/.test(m));
  assert.equal(hits.length, 1, logged.join(" | "));
  assert.match(hits[0], /192\.168\.1\.2/);
  assert.match(hits[0], /one address/);
});
