import "./env.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fail, userFacing } from "../server/core/errors.js";
import { OutboundError } from "../server/core/outbound.js";
import { app } from "../server/http/app.js";
import { COOKIE, SETUP_TOKEN } from "../server/http/auth.js";

let cookie = "";
const call = (method: "GET" | "POST" | "DELETE", url: string, body?: object) =>
  app.inject({ method, url, remoteAddress: "203.0.113.7", headers: { host: "192.168.1.5:8383", "x-tastearr": "1", cookie }, payload: body });

before(async () => {
  await app.ready();
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/setup",
    remoteAddress: "172.17.0.1",
    headers: { host: "192.168.1.5:8383", "x-tastearr": "1" },
    payload: { username: "owner", password: "correct horse", setupToken: SETUP_TOKEN },
  });
  cookie = `${COOKIE}=${res.cookies.find((c) => c.name === COOKIE)?.value}`;
});
after(async () => {
  await app.close();
});

test("using a detected app that is gone is a 400 with its message, not a 500", async () => {
  const res = await call("POST", "/api/discover/use", { id: "nope", url: "http://192.168.1.9:8989" });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "That app is no longer detected");
});

test("removing an extra Sonarr that isn't there is a 404", async () => {
  for (const i of ["0", "7", "-1", "x"]) assert.equal((await call("DELETE", `/api/sonarr/extra/${i}`)).statusCode, 404, i);
});

test("a bad address is a 400, a bad id is a 400, an unknown key is a 400", async () => {
  assert.equal((await call("POST", "/api/sonarr/test", { url: "ftp://x", apiKey: "k" })).statusCode, 400);
  assert.equal((await call("POST", "/api/picks/abc/follow")).statusCode, 400);
  assert.equal((await call("POST", "/api/settings/keys/nothing/regenerate")).statusCode, 400);
});

test("userFacing turns a plain Error into a status error and leaves status errors alone", async () => {
  await assert.rejects(
    userFacing(() => Promise.reject(new Error("nope")), 409),
    (e: Error & { statusCode?: number }) => e.message === "nope" && e.statusCode === 409,
  );
  await assert.rejects(
    userFacing(() => {
      throw fail("gone", 404);
    }, 409),
    (e: Error & { statusCode?: number }) => e.statusCode === 404,
  );
  assert.equal(await userFacing(() => 5), 5);
  assert.equal(new OutboundError("x").statusCode, 400);
});
