import "./env.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { blockedHost, checkOutbound } from "../server/outbound.js";

test("LAN, loopback, Docker and public addresses stay allowed (Sonarr/Radarr/Plex live there)", () => {
  for (const u of ["http://192.168.1.10:8989", "http://10.0.0.2:7878", "http://172.17.0.1:8989", "http://127.0.0.1:32400", "http://sonarr:8989/sonarr", "https://ntfy.sh/topic", "http://[fd00::5]:8096", "http://[::1]:8989", "https://discord.com/api/webhooks/1/x"])
    assert.equal(checkOutbound(u), u, u);
});

test("link-local and cloud-metadata addresses are refused in every spelling", () => {
  for (const u of [
    "http://169.254.169.254/latest/meta-data",
    "http://2852039166/", // decimal form of 169.254.169.254
    "http://0xa9.0xfe.0xa9.0xfe/",
    "http://[::ffff:169.254.169.254]/",
    "http://[::ffff:a9fe:a9fe]/",
    "http://[64:ff9b::a9fe:a9fe]/",
    "http://[fe80::1]/",
    "http://[fd00:ec2::254]/",
    "http://0.0.0.0:8989",
    "http://[::]/",
    "http://metadata.google.internal/computeMetadata/v1/",
    "http://metadata.google.internal./",
    "http://100.100.100.200/",
  ])
    assert.throws(() => checkOutbound(u), (e: Error & { statusCode?: number }) => e.statusCode === 400, u);
});

test("only http and https", () => {
  for (const u of ["ftp://192.168.1.2/", "file:///etc/passwd", "javascript:alert(1)", "gopher://x", "not a url", ""]) assert.throws(() => checkOutbound(u), Error, u);
});

test("blockedHost reads bare hostnames too", () => {
  assert.equal(blockedHost("169.254.1.1"), true);
  assert.equal(blockedHost("[fe80::abcd]"), true);
  assert.equal(blockedHost("192.168.1.1"), false);
});
