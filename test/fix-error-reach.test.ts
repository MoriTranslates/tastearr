import "./env.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { safeFetch } from "../server/adapters/net.js";
import { app, errorForLog } from "../server/http/app.js";
import { mockFetch } from "./helpers.ts";

/**
 * Fix-branch review #9: an outside service that can't be reached ("TypeError: fetch failed" with the reason in
 * `cause`) is a 502 naming the problem, not "something went wrong on the server"; and logged errors never carry
 * credentials or tokens from a URL.
 */

const fetchFailed = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) });

app.get("/api/test-reach/:kind", { config: { public: true } }, async (req) => {
  const kind = (req.params as { kind: string }).kind;
  if (kind === "raw") throw fetchFailed("ECONNREFUSED");
  return safeFetch("http://sonarr.test:8989/api/v3/series", {}, "The Sonarr address");
});
before(async () => {
  await app.ready();
});
after(async () => {
  await app.close();
});
const get = (kind: string) => app.inject({ method: "GET", url: `/api/test-reach/${kind}`, headers: { host: "192.168.1.5:8383" } });

test("safeFetch names the service and the reason when it can't be reached (502)", async () => {
  const m = mockFetch(() => {
    throw fetchFailed("ECONNREFUSED");
  });
  try {
    await assert.rejects(
      safeFetch("http://sonarr.test:8989/api/v3/series", {}, "The Sonarr address"),
      (e: Error & { statusCode?: number }) =>
        e.statusCode === 502 && /The Sonarr address can't be reached \(ECONNREFUSED\)/.test(e.message),
    );
    const res = await get("safe");
    assert.equal(res.statusCode, 502);
    assert.match(res.json().error, /The Sonarr address can't be reached \(ECONNREFUSED\)/);
  } finally {
    m.restore();
  }
});

test("a timeout is named too", async () => {
  const m = mockFetch(() => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  });
  try {
    await assert.rejects(
      safeFetch("http://sonarr.test:8989/api/v3/series", {}, "The Sonarr address"),
      (e: Error & { statusCode?: number }) => e.statusCode === 504 && /The Sonarr address didn't answer in time/.test(e.message),
    );
  } finally {
    m.restore();
  }
});

test("any other 'fetch failed' reaching the error handler is a 502 'can't reach' with the reason, not a server error", async () => {
  const res = await get("raw");
  assert.equal(res.statusCode, 502);
  assert.match(res.json().error, /couldn't be reached \(ECONNREFUSED\)/);
  assert.doesNotMatch(res.json().error, /Something went wrong on the server/);
});

test("logged errors keep the useful parts but never credentials or tokens from a URL", () => {
  const bad = Object.assign(new TypeError("Invalid URL: http://user:secret-pass@plex.lan:32400/?X-Plex-Token=tok123&x=1"), {
    code: "ERR_INVALID_URL",
    input: "http://user:secret-pass@plex.lan:32400/?X-Plex-Token=tok123&x=1",
  });
  const logged = JSON.stringify(errorForLog(bad));
  assert.doesNotMatch(logged, /secret-pass|tok123/);
  assert.match(logged, /ERR_INVALID_URL/);
  assert.match(logged, /plex\.lan/);
  assert.ok(!("input" in errorForLog(bad)), "only known fields are logged");
});
