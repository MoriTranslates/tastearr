import "./env.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, test } from "node:test";
import { CONFIG_DIR } from "../server/config.js";
import { app, routes } from "../server/http/app.js";
import { COOKIE, SETUP_TOKEN } from "../server/http/auth.js";
import { getSettings, setBypassLocal } from "../server/services/settings.js";

/** Routes that check their own credentials (webhook key, signed link) or must work before login. Anything else is guarded. */
const PUBLIC = [
  "POST /api/webhook/sonarr",
  "POST /api/webhook/sonarr/:key",
  "POST /api/webhook/radarr/:key",
  "GET /api/importlist/sonarr/:key",
  "GET /api/importlist/radarr/:key",
  "POST /api/actions/drop/:tvdbId",
];
const SETUP = ["GET /api/status", "POST /api/auth/setup", "POST /api/auth/login"];
const HOME = "192.168.1.20";
const HOST = { host: "192.168.1.5:8383" };

const fill = (url: string) => url.replace(":which", "apiKey").replace(":key", "wrong-key").replace(/:\w+/g, "1");
const apiRoutes = () =>
  routes
    .filter((r) => r.url.startsWith("/api/"))
    .flatMap((r) =>
      (Array.isArray(r.method) ? r.method : [r.method])
        .filter((m) => m !== "HEAD")
        .map((method) => ({ method, url: r.url, config: r.config, key: `${method} ${r.url}` })),
    );
const inject = (o: { method: string; url: string; ip?: string; headers?: Record<string, string>; body?: unknown }) =>
  app.inject({
    method: o.method as "GET",
    url: o.url,
    remoteAddress: o.ip ?? "203.0.113.7",
    headers: { ...HOST, ...o.headers },
    payload: o.body as object,
  });
let cookie = "";

before(async () => {
  await app.ready();
});
after(async () => {
  await app.close();
});

test("only the intended routes are public or reachable before login", () => {
  const all = apiRoutes();
  assert.ok(all.length > 40, `found ${all.length} routes`);
  assert.deepEqual(
    all
      .filter((r) => r.config.public)
      .map((r) => r.key)
      .sort(),
    [...PUBLIC].sort(),
  );
  assert.deepEqual(
    all
      .filter((r) => r.config.setup)
      .map((r) => r.key)
      .sort(),
    [...SETUP].sort(),
  );
});

test("before an account exists every guarded route asks for one", async () => {
  for (const r of apiRoutes().filter((r) => !r.config.public && !r.config.setup)) {
    const res = await inject({ method: r.method, url: fill(r.url), ip: HOME, headers: { "x-tastearr": "1" }, body: {} });
    assert.equal(res.statusCode, 401, r.key);
    assert.equal(res.json().setupRequired, true, r.key);
  }
});

test("a fresh install can't be claimed through Docker's gateway or loopback without the setup code", async () => {
  for (const ip of ["172.17.0.1", "127.0.0.1", "203.0.113.7"]) {
    const res = await inject({
      method: "POST",
      url: "/api/auth/setup",
      ip,
      headers: { "x-tastearr": "1" },
      body: { username: "owner", password: "correct horse" },
    });
    assert.equal(res.statusCode, 403, ip);
  }
  const forwarded = await inject({
    method: "POST",
    url: "/api/auth/setup",
    ip: HOME,
    headers: { "x-tastearr": "1", "x-forwarded-for": HOME },
    body: { username: "owner", password: "correct horse" },
  });
  assert.equal(forwarded.statusCode, 403, "through a proxy");
  const noHeader = await inject({
    method: "POST",
    url: "/api/auth/setup",
    ip: HOME,
    body: { username: "owner", password: "correct horse" },
  });
  assert.equal(noHeader.statusCode, 403, "CSRF header required");
  assert.equal(getSettings().auth.passwordHash, "");
});

test("the setup code claims it from anywhere, once", async () => {
  const res = await inject({
    method: "POST",
    url: "/api/auth/setup",
    ip: "172.17.0.1",
    headers: { "x-tastearr": "1" },
    body: { username: "owner", password: "correct horse", setupToken: SETUP_TOKEN },
  });
  assert.equal(res.statusCode, 200);
  const set = res.cookies.find((c) => c.name === COOKIE);
  assert.ok(set?.httpOnly && set.sameSite === "Strict");
  cookie = `${COOKIE}=${set.value}`;
  const again = await inject({
    method: "POST",
    url: "/api/auth/setup",
    ip: HOME,
    headers: { "x-tastearr": "1" },
    body: { username: "x", password: "another password", setupToken: SETUP_TOKEN },
  });
  assert.equal(again.statusCode, 409);
});

test("without credentials every non-public /api route is 401; public ones reject a wrong key", async () => {
  for (const r of apiRoutes()) {
    if (r.config.setup) continue;
    const res = await inject({ method: r.method, url: fill(r.url), headers: { "x-tastearr": "1" }, body: {} });
    assert.equal(res.statusCode, 401, r.key);
  }
  const status = await inject({ method: "GET", url: "/api/status" });
  assert.deepEqual(Object.keys(status.json()).sort(), ["loggedIn", "setupRequired", "version"]);
  assert.equal(
    (
      await inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { "x-tastearr": "1" },
        body: { username: "owner", password: "nope" },
      })
    ).statusCode,
    401,
  );
});

test("with a session, every state-changing route needs the CSRF header and a same-origin Origin", async () => {
  for (const r of apiRoutes().filter((r) => r.method !== "GET" && !r.config.public)) {
    const plain = await inject({ method: r.method, url: fill(r.url), headers: { cookie }, body: {} });
    assert.equal(plain.statusCode, r.key === "POST /api/auth/setup" ? 409 : 403, `${r.key} without header`);
    if (r.config.setup) continue;
    const cross = await inject({
      method: r.method,
      url: fill(r.url),
      headers: { cookie, "x-tastearr": "1", origin: "https://evil.example.com" },
      body: {},
    });
    assert.equal(cross.statusCode, 403, `${r.key} cross-origin`);
  }
});

test("the admin API key works in the header only", async () => {
  const key = getSettings().apiKey;
  assert.equal((await inject({ method: "GET", url: "/api/settings", headers: { "x-api-key": key } })).statusCode, 200);
  assert.equal((await inject({ method: "GET", url: `/api/settings?apikey=${key}` })).statusCode, 401);
});

test("settings: secrets stay masked, and metadata addresses are a 400", async () => {
  const bad = await inject({
    method: "PUT",
    url: "/api/settings",
    headers: { cookie, "x-tastearr": "1" },
    body: { sonarr: { url: "http://169.254.169.254" } },
  });
  assert.equal(bad.statusCode, 400);
  const ok = await inject({
    method: "PUT",
    url: "/api/settings",
    headers: { cookie, "x-tastearr": "1" },
    body: { sonarr: { url: "http://192.168.1.10:8989", apiKey: "fake-sonarr" } },
  });
  assert.equal(ok.statusCode, 200);
  assert.ok(!ok.body.includes("fake-sonarr"));
  assert.equal(getSettings().sonarr.apiKey, "fake-sonarr");
});

test("'disabled for local addresses' only trusts the real home network, addressed by IP or LAN name", async () => {
  setBypassLocal(true);
  try {
    const get = (ip: string, headers: Record<string, string> = {}) => inject({ method: "GET", url: "/api/settings", ip, headers });
    assert.equal((await get(HOME)).statusCode, 200);
    assert.equal((await get("10.0.0.8", { host: "tower:8383" })).statusCode, 200);
    assert.equal((await get("172.17.0.1")).statusCode, 401, "Docker gateway");
    assert.equal((await get("127.0.0.1")).statusCode, 401, "loopback");
    assert.equal((await get(HOME, { "x-forwarded-for": "8.8.8.8" })).statusCode, 401, "proxied");
    assert.equal((await get(HOME, { host: "rebind.attacker.example" })).statusCode, 401, "DNS rebinding");
    const keys = await inject({ method: "GET", url: "/api/settings/keys", ip: HOME });
    assert.equal(keys.json().apiKey, null, "the admin key needs a password login");
  } finally {
    setBypassLocal(false);
  }
});

test("backup needs the password, streams a real SQLite file and leaves no copy behind", async () => {
  const wrong = await inject({
    method: "POST",
    url: "/api/system/backup",
    headers: { cookie, "x-tastearr": "1" },
    body: { password: "nope" },
  });
  assert.equal(wrong.statusCode, 403);
  const res = await inject({
    method: "POST",
    url: "/api/system/backup",
    headers: { cookie, "x-tastearr": "1" },
    body: { password: "correct horse" },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.rawPayload.subarray(0, 15).toString(), "SQLite format 3");
  for (let i = 0; i < 50 && fs.readdirSync(CONFIG_DIR).some((f) => f.startsWith("backup-")); i++)
    await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(
    fs.readdirSync(CONFIG_DIR).filter((f) => f.startsWith("backup-")),
    [],
  );
});

test("logging out revokes that session on the server", async () => {
  assert.equal((await inject({ method: "GET", url: "/api/settings", headers: { cookie } })).statusCode, 200);
  assert.equal(
    (await inject({ method: "POST", url: "/api/auth/logout", headers: { cookie, "x-tastearr": "1" }, body: {} })).statusCode,
    200,
  );
  assert.equal(
    (await inject({ method: "GET", url: "/api/settings", headers: { cookie } })).statusCode,
    401,
    "the old cookie no longer works",
  );
  const login = await inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { "x-tastearr": "1" },
    body: { username: "owner", password: "correct horse" },
  });
  assert.equal(login.statusCode, 200);
});
