import "./env.ts";
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { applyUpdate, loadSettings } from "../server/core/settings.js";
import { listEntries, replaceListEntries } from "../server/data/lists.js";
import { app } from "../server/http/app.js";
import { COOKIE, SETUP_TOKEN } from "../server/http/auth.js";
import { context, invalidateContext } from "../server/services/context.js";
import { forgetUnconfiguredLists, refreshListsDetailed } from "../server/services/lists.js";
import { patchSettings } from "../server/services/settings.js";
import { writeAnimeList } from "./world.ts";

/** Review 2026-11-02, items 7, 9 and 10 (error responses). */

// Routes that fail the way internal code can (registered before the app starts; public so no login is needed).
class OurOwn extends Error {}
app.get("/api/test-fail/:kind", { config: { public: true } }, async (req) => {
  const kind = (req.params as { kind: string }).kind;
  if (kind === "sqlite") throw Object.assign(new Error('near "SELEC": syntax error in /config/tastearr.db'), { code: "ERR_SQLITE_ERROR" });
  if (kind === "dns") throw Object.assign(new Error("getaddrinfo ENOTFOUND internal-host.corp"), { code: "ENOTFOUND" });
  if (kind === "type") throw new TypeError("Cannot read properties of undefined (reading 'secretField')");
  throw new OurOwn("Sonarr GET /series failed (HTTP 401)");
});
after(async () => {
  await app.close();
});

const seedLists = () => {
  replaceListEntries("anilist", [{ id: 10, status: "COMPLETED", score: 90, progress: 12 }]);
  replaceListEntries("mal", [{ id: 20, status: "COMPLETED", score: 80, progress: 12 }]);
};
const sources = () => [...new Set(listEntries().map((e) => e.source))].sort();

describe("item 7: a cleared AniList/MAL username stops training the profile", () => {
  before(() => writeAnimeList([]));

  test("clearing the AniList username removes its entries; MAL with a username but no client ID keeps its last import", () => {
    seedLists();
    patchSettings((s) => ({ ...s, lists: { anilistUser: "", malUser: "bob", malClientId: "" } }));
    assert.equal(forgetUnconfiguredLists(), 1);
    assert.deepEqual(sources(), ["mal"], "MAL couldn't be checked: unknown, not 'gone'");
    patchSettings((s) => ({ ...s, lists: { anilistUser: "", malUser: "", malClientId: "" } }));
    assert.equal(forgetUnconfiguredLists(), 1);
    assert.deepEqual(sources(), []);
  });

  test("the profile build's list refresh forgets an unconfigured list before importing", async () => {
    seedLists();
    const r = await refreshListsDetailed({ anilistUser: "", malUser: "", malClientId: "" });
    assert.deepEqual(r, { imported: [], errors: [] });
    assert.deepEqual(sources(), []);
    invalidateContext();
    assert.equal((await context(true)).lists.size, 0, "nothing left to train on");
  });

  test("saving settings with the username cleared removes the entries at once (PUT /api/settings)", async () => {
    await app.ready();
    const setup = await app.inject({
      method: "POST",
      url: "/api/auth/setup",
      remoteAddress: "203.0.113.2",
      headers: { host: "192.168.1.5:8383", "x-tastearr": "1" },
      payload: { username: "owner", password: "correct horse", setupToken: SETUP_TOKEN },
    });
    const cookie = `${COOKIE}=${setup.cookies.find((c) => c.name === COOKIE)?.value}`;
    patchSettings((s) => ({ ...s, lists: { anilistUser: "adam", malUser: "bob", malClientId: "cid" } }));
    seedLists();
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings",
      remoteAddress: "203.0.113.2",
      headers: { host: "192.168.1.5:8383", "x-tastearr": "1", cookie },
      payload: { lists: { anilistUser: "" } },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(sources(), ["mal"]);
  });
});

describe("item 9: applyUpdate validates before anything reaches the current settings", () => {
  test("a patch that fails the outbound check leaves the current settings object untouched", () => {
    const { settings: cur } = loadSettings({ radarr: { url: "http://192.168.1.10:7878/" }, notify: { ntfyUrl: "my-topic" } });
    const before = structuredClone(cur);
    assert.throws(() => applyUpdate(cur, { sonarr: { url: "http://169.254.169.254/" } }));
    assert.deepEqual(cur, before, "no section was normalised in place");
    assert.equal(cur.radarr.url, "http://192.168.1.10:7878/");
  });

  test("a good patch returns new settings and still doesn't change the object it was given", () => {
    const { settings: cur } = loadSettings({ radarr: { url: "http://192.168.1.10:7878/" } });
    const before = structuredClone(cur);
    const next = applyUpdate(cur, { sonarr: { url: "http://192.168.1.10:8989/" } });
    assert.equal(next.sonarr.url, "http://192.168.1.10:8989");
    assert.equal(next.radarr.url, "http://192.168.1.10:7878");
    assert.deepEqual(cur, before);
    assert.notEqual(next.radarr, cur.radarr, "no section is shared with the input");
  });
});

describe("item 10: a 500 never sends internal error text to the browser", () => {
  const get = (kind: string) => app.inject({ method: "GET", url: `/api/test-fail/${kind}`, headers: { host: "192.168.1.5:8383" } });

  for (const [kind, secret] of [
    ["sqlite", /SELEC|tastearr\.db/],
    ["dns", /internal-host|ENOTFOUND/],
    ["type", /secretField/],
  ] as const)
    test(`${kind}: a generic message with a log reference, not the error text`, async () => {
      const res = await get(kind);
      assert.equal(res.statusCode, 500);
      const body = res.json() as { error: string };
      assert.doesNotMatch(body.error, secret);
      assert.match(body.error, /Something went wrong on the server.*\(ref req-[\w-]+\)/);
    });

  test("our own messages (written for the user) still come through", async () => {
    const res = await get("own");
    assert.equal(res.statusCode, 500);
    assert.equal(res.json().error, "Sonarr GET /series failed (HTTP 401)");
  });
});
