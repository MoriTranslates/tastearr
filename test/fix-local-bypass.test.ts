import "./env.ts";
import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { app } from "../server/http/app.js";
import { localNetworkWarnings, SETUP_TOKEN } from "../server/http/auth.js";
import { setBypassLocal } from "../server/services/settings.js";

/**
 * Sister-app port from AnimeArr: the "no password on my home network" bypass, over real HTTP requests. Any forwarding
 * header means a proxy or tunnel relayed the request (whatever TRUST_PROXY says), the socket peer is judged rather
 * than the claimed client IP, a listed proxy or a hop count never gets the bypass, Docker's 172.16/12 and loopback are
 * never local, and IPv4-mapped IPv6 peers are judged as their IPv4 address.
 */

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
  setBypassLocal(true);
});
after(async () => {
  await app.close();
});
afterEach(() => {
  delete process.env.TRUST_PROXY;
  delete process.env.TASTEARR_LOCAL_NETWORKS;
});

/** A signed-out GET of a guarded route: 200 means the bypass let it through. */
const settings = (peer: string, headers: Record<string, string> = {}) =>
  app.inject({ method: "GET", url: "/api/settings", remoteAddress: peer, headers: { host: "192.168.1.5:8383", ...headers } });

test("a LAN device with no forwarding header gets the bypass (the baseline)", async () => {
  assert.equal((await settings("192.168.1.20")).statusCode, 200);
  assert.equal((await settings("::ffff:192.168.1.20")).statusCode, 200, "IPv4-mapped is judged as 192.168.1.20");
});

test("with TRUST_PROXY listing a proxy, a LAN peer that sends X-Forwarded-For does not get the bypass", async () => {
  process.env.TRUST_PROXY = "192.168.1.2";
  assert.equal((await settings("192.168.1.20", { "x-forwarded-for": "192.168.1.20" })).statusCode, 401);
  assert.equal((await settings("192.168.1.20", { forwarded: "for=192.168.1.20" })).statusCode, 401);
  assert.equal((await settings("192.168.1.20", { "x-real-ip": "192.168.1.20" })).statusCode, 401);
});

test("the listed proxy itself never gets the bypass, with or without a forwarded LAN address", async () => {
  process.env.TRUST_PROXY = "192.168.1.2";
  assert.equal((await settings("192.168.1.2")).statusCode, 401);
  assert.equal((await settings("192.168.1.2", { "x-forwarded-for": "192.168.1.20" })).statusCode, 401);
  process.env.TRUST_PROXY = "192.168.1.0/24";
  assert.equal((await settings("::ffff:192.168.1.2")).statusCode, 401, "a mapped address inside the listed range");
});

test("a hop-count TRUST_PROXY turns the bypass off", async () => {
  process.env.TRUST_PROXY = "1";
  assert.equal((await settings("192.168.1.20")).statusCode, 401);
});

test("Docker's 172.16/12 and loopback are never local, even when TASTEARR_LOCAL_NETWORKS lists them", async () => {
  for (const peer of ["172.17.0.1", "::ffff:172.17.0.1", "127.0.0.1", "::1", "::ffff:127.0.0.1"])
    assert.equal((await settings(peer)).statusCode, 401, peer);
  process.env.TASTEARR_LOCAL_NETWORKS = "172.16.0.0/12, 127.0.0.0/8, 10.0.0.0/8";
  for (const peer of ["172.17.0.1", "::ffff:172.18.0.5", "127.0.0.1"]) assert.equal((await settings(peer)).statusCode, 401, peer);
  assert.equal((await settings("10.1.2.3")).statusCode, 200, "the other listed networks still count");
});

test("an internet address is never local", async () => {
  assert.equal((await settings("203.0.113.9")).statusCode, 401);
  assert.equal((await settings("::ffff:203.0.113.9")).statusCode, 401);
});

test("fix review #12: an IPv6 ULA peer (Docker's IPv6 bridge gateway) is not local; IPv6 link-local still is", async () => {
  for (const peer of ["fd00::1", "fd12:3456::1", "fc00::5"]) assert.equal((await settings(peer)).statusCode, 401, peer);
  assert.equal((await settings("fe80::1")).statusCode, 200);
});

test("fix review #12: a TASTEARR_LOCAL_NETWORKS range the bypass will ignore is named in a startup warning", () => {
  process.env.TASTEARR_LOCAL_NETWORKS = "172.20.0.0/16, 10.0.0.0/8, 127.0.0.0/8, 172.0.0.0/8";
  const w = localNetworkWarnings();
  assert.equal(w.length, 1);
  assert.match(w[0], /172\.20\.0\.0\/16, 127\.0\.0\.0\/8, 172\.0\.0\.0\/8/);
  assert.match(w[0], /never count as local/);
  process.env.TASTEARR_LOCAL_NETWORKS = "10.20.0.0/16";
  assert.deepEqual(localNetworkWarnings(), []);
  delete process.env.TASTEARR_LOCAL_NETWORKS;
  assert.deepEqual(localNetworkWarnings(), []);
});
