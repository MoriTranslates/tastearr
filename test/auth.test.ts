import "./env.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { csrfOk, hostAllowed, inCidr, isHomeNetwork, isLocalRequest, makeSession, revokeSession, signAction, trustProxyOption, validSession, verifyAction } from "../server/auth.js";
import { setAccount } from "../server/settings.js";
import { fakeReq } from "./helpers.ts";

afterEach(() => {
  delete process.env.TRUST_PROXY;
  delete process.env.TASTEARR_LOCAL_NETWORKS;
  delete process.env.TASTEARR_ALLOWED_HOSTS;
});

test("home network: 10/8, 192.168/16 and IPv6 ULA/link-local; never Docker's 172.16/12 or loopback", () => {
  for (const ip of ["10.0.0.5", "192.168.1.20", "::ffff:192.168.0.9", "fd12:3456::1", "fe80::1"]) assert.equal(isHomeNetwork(ip), true, ip);
  for (const ip of ["172.17.0.1", "172.18.0.1", "::ffff:172.17.0.1", "127.0.0.1", "::1", "8.8.8.8", "2001:db8::1", "100.64.0.1"]) assert.equal(isHomeNetwork(ip), false, ip);
});

test("TASTEARR_LOCAL_NETWORKS replaces the defaults", () => {
  process.env.TASTEARR_LOCAL_NETWORKS = "172.20.0.0/16, 10.20.0.0/16";
  assert.equal(isHomeNetwork("172.20.3.4"), true);
  assert.equal(isHomeNetwork("10.20.5.9"), true);
  assert.equal(isHomeNetwork("192.168.1.20"), false);
  assert.equal(inCidr("10.1.2.3", "10.0.0.0/8"), true);
  assert.equal(inCidr("11.1.2.3", "10.0.0.0/8"), false);
  assert.equal(inCidr("10.1.2.3", "10.1.2.3"), true);
});

test("isLocalRequest: a Docker gateway / loopback address is not local (internet traffic NATed by docker-proxy)", () => {
  assert.equal(isLocalRequest(fakeReq({ ip: "192.168.1.20" })), true);
  assert.equal(isLocalRequest(fakeReq({ ip: "172.17.0.1" })), false);
  assert.equal(isLocalRequest(fakeReq({ ip: "127.0.0.1" })), false);
  assert.equal(isLocalRequest(fakeReq({ ip: "203.0.113.9" })), false);
});

test("isLocalRequest: any forwarding header means a proxy or tunnel, unless TRUST_PROXY names it", () => {
  for (const h of ["x-forwarded-for", "forwarded", "x-real-ip", "cf-connecting-ip", "via"]) assert.equal(isLocalRequest(fakeReq({ headers: { [h]: "192.168.1.20" } })), false, h);
});

test("isLocalRequest: a hop-count TRUST_PROXY never allows the bypass (X-Forwarded-For could be forged)", () => {
  process.env.TRUST_PROXY = "1";
  assert.equal(trustProxyOption(), 1);
  assert.equal(isLocalRequest(fakeReq({ ip: "192.168.1.20" })), false);
});

test("isLocalRequest: a request relayed by the trusted proxy is not the user's own device", () => {
  process.env.TRUST_PROXY = "192.168.1.2";
  assert.equal(isLocalRequest(fakeReq({ ip: "192.168.1.20", peer: "192.168.1.2", headers: { "x-forwarded-for": "192.168.1.20" } })), false);
  assert.equal(isLocalRequest(fakeReq({ ip: "192.168.1.30" })), true);
});

test("TRUST_PROXY=true is refused", () => {
  process.env.TRUST_PROXY = "true";
  assert.equal(trustProxyOption(), false);
});

test("hostAllowed: IPs and LAN names only (DNS-rebinding guard)", () => {
  for (const host of ["192.168.1.5:8383", "[fd00::5]:8383", "tower:8383", "localhost", "nas.local", "media.lan", "x.home.arpa"]) assert.equal(hostAllowed(fakeReq({ headers: { host } })), true, host);
  for (const host of ["evil.example.com", "tastearr.mydomain.com:443", ""]) assert.equal(hostAllowed(fakeReq({ headers: { host } })), false, host);
  process.env.TASTEARR_ALLOWED_HOSTS = "tastearr.mydomain.com";
  assert.equal(hostAllowed(fakeReq({ headers: { host: "tastearr.mydomain.com" } })), true);
});

test("csrfOk: reads pass; writes need our header and a same-origin Origin", () => {
  assert.equal(csrfOk(fakeReq({ method: "GET" })), true);
  assert.equal(csrfOk(fakeReq({ method: "POST" })), false);
  assert.equal(csrfOk(fakeReq({ method: "POST", headers: { "x-tastearr": "1" } })), true);
  assert.equal(csrfOk(fakeReq({ method: "POST", headers: { "x-tastearr": "1", origin: "http://192.168.1.5:8383" } })), true);
  assert.equal(csrfOk(fakeReq({ method: "PUT", headers: { "x-tastearr": "1", origin: "https://evil.example.com" } })), false);
  assert.equal(csrfOk(fakeReq({ method: "DELETE", headers: { "x-tastearr": "1", origin: "not a url" } })), false);
});

test("sessions: valid, tampered, expired, other user, rotated secret, revoked", async () => {
  await setAccount("owner", "password123");
  const t = makeSession("owner");
  assert.equal(validSession(t), true);
  assert.equal(validSession(undefined), false);
  assert.equal(validSession(t.slice(0, -2) + "xx"), false);
  const [user, exp, nonce, sig] = t.split(".");
  assert.equal(validSession(`${user}.${Number(exp) + 1000}.${nonce}.${sig}`), false, "extended expiry without re-signing");
  assert.equal(validSession(makeSession("someone-else")), false);

  const realNow = Date.now;
  Date.now = () => realNow() + 31 * 86_400_000;
  try {
    assert.equal(validSession(t), false, "expired");
  } finally {
    Date.now = realNow;
  }

  const t2 = makeSession("owner");
  assert.equal(revokeSession(t2), true);
  assert.equal(validSession(t2), false, "revoked on logout");
  assert.equal(validSession(t), true, "other sessions keep working");

  await setAccount("owner", "a-new-password");
  assert.equal(validSession(t), false, "a password change signs everyone out");
});

test("signed action links: right action and id only, and they expire", () => {
  const { exp, sig } = signAction("drop", 42);
  assert.equal(verifyAction("drop", 42, exp, sig), true);
  assert.equal(verifyAction("drop", 43, exp, sig), false);
  assert.equal(verifyAction("other", 42, exp, sig), false);
  const old = signAction("drop", 42, -1);
  assert.equal(verifyAction("drop", 42, old.exp, old.sig), false);
});
