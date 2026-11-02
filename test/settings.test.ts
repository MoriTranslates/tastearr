import "./env.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkPassword,
  getSettings,
  isMasked,
  MASK,
  patchSettings,
  publicSettings,
  safeEqual,
  setAccount,
  updateSettings,
} from "../server/settings.js";

const secrets = () =>
  patchSettings((s) => ({
    ...s,
    sonarr: { ...s.sonarr, url: "http://192.168.1.10:8989", apiKey: "fake-sonarr" },
    radarr: { ...s.radarr, url: "http://192.168.1.10:7878", apiKey: "fake-radarr" },
    media: { ...s.media, type: "plex", url: "http://192.168.1.10:32400", token: "fake-plex" },
    notify: {
      ...s.notify,
      discordWebhook: "https://discord.com/api/webhooks/1/fake-hook",
      ntfyUrl: "https://ntfy.sh/topic",
      ntfyToken: "fake-ntfy",
      gotifyUrl: "http://gotify.lan",
      gotifyToken: "fake-gotify",
    },
    lists: { ...s.lists, malClientId: "fake-mal" },
    sonarrExtra: [{ name: "4K", url: "http://192.168.1.11:8989", apiKey: "fake-extra" }],
  }));

test("first read creates the keys and signing secret", () => {
  const s = getSettings();
  assert.match(s.apiKey, /^[0-9a-f]{32}$/);
  assert.match(s.webhookKey, /^[0-9a-f]{32}$/);
  assert.match(s.secret, /^[0-9a-f]{64}$/);
  assert.ok(s.plexClientId);
});

test("publicSettings never sends a secret, hash or signing key to the browser", async () => {
  await setAccount("owner", "password123");
  secrets();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- typed once the API types are shared
  const p = publicSettings() as Record<string, any>;
  const text = JSON.stringify(p);
  const s = getSettings();
  for (const v of [
    "fake-sonarr",
    "fake-radarr",
    "fake-plex",
    "fake-hook",
    "fake-ntfy",
    "fake-gotify",
    "fake-mal",
    "fake-extra",
    s.secret,
    s.apiKey,
    s.auth.passwordHash,
    s.plexClientId,
  ])
    assert.ok(!text.includes(v), `leaked ${v.slice(0, 8)}`);
  assert.equal(p.sonarr.apiKey, MASK);
  assert.equal(p.notify.discordWebhook, MASK);
  assert.equal(p.sonarrExtra[0].apiKey, MASK);
  assert.equal(p.auth.hasPassword, true);
  assert.equal("passwordHash" in p.auth, false);
  for (const k of ["secret", "apiKey", "plexClientId"]) assert.equal(k in p, false, k);
  assert.equal(getSettings().sonarr.apiKey, "fake-sonarr", "the stored copy is untouched");
});

test("updateSettings ignores fields that aren't editable from the browser", () => {
  const before = getSettings();
  updateSettings({
    apiKey: "x",
    secret: "y",
    webhookKey: "z",
    auth: { username: "attacker", passwordHash: "", bypassLocal: true },
    sonarrExtra: [],
    nonsense: 1,
  });
  const after = getSettings();
  assert.equal(after.apiKey, before.apiKey);
  assert.equal(after.secret, before.secret);
  assert.equal(after.webhookKey, before.webhookKey);
  assert.deepEqual(after.auth, before.auth);
  assert.equal(after.sonarrExtra.length, 1);
  assert.equal((after as unknown as Record<string, unknown>).nonsense, undefined);
});

test("updateSettings coerces types, enums and ranges", () => {
  updateSettings({
    notify: { picks: 999, airingDelayMin: -5 },
    display: { titleLanguage: "klingon" },
    training: { seasons: "4" },
    autoAdd: { enabled: "yes" },
    sonarr: { qualityProfileId: "7", tags: ["3", "x", 5] },
  });
  const s = getSettings();
  assert.equal(s.notify.picks, 30);
  assert.equal(s.notify.airingDelayMin, 0);
  assert.equal(s.display.titleLanguage, "english");
  assert.equal(s.training.seasons, 4);
  assert.equal(s.autoAdd.enabled, false, "a string isn't a boolean");
  assert.equal(s.sonarr.qualityProfileId, 7);
  assert.deepEqual(s.sonarr.tags, [3, 5]);
});

test("a masked secret means unchanged; a new address drops it; a new key is saved", () => {
  updateSettings({ sonarr: { url: "http://192.168.1.10:8989/", apiKey: MASK } });
  assert.equal(getSettings().sonarr.apiKey, "fake-sonarr", "same address (trailing slash ignored)");
  updateSettings({ sonarr: { url: "http://192.168.1.99:8989", apiKey: MASK } });
  assert.equal(getSettings().sonarr.url, "http://192.168.1.99:8989");
  assert.equal(getSettings().sonarr.apiKey, "", "the old key isn't sent to a new address");
  updateSettings({ sonarr: { apiKey: "new-key" } });
  assert.equal(getSettings().sonarr.apiKey, "new-key");
  updateSettings({ notify: { ntfyUrl: "my-alerts", ntfyToken: MASK } });
  assert.equal(getSettings().notify.ntfyUrl, "https://ntfy.sh/my-alerts");
});

test("addresses Tastearr will call are checked when they change", () => {
  for (const patch of [
    { sonarr: { url: "http://169.254.169.254" } },
    { radarr: { url: "http://[::ffff:169.254.169.254]:7878" } },
    { media: { url: "file:///config/tastearr.db" } },
    { notify: { discordWebhook: "http://metadata.google.internal/x" } },
    { notify: { gotifyUrl: "http://[fe80::1]" } },
    { notify: { ntfyUrl: "http://169.254.169.254/topic" } },
    { externalUrl: "javascript:alert(1)" },
  ])
    assert.throws(
      () => updateSettings(patch),
      (e: Error & { statusCode?: number }) => e.statusCode === 400,
      JSON.stringify(patch),
    );
  assert.equal(getSettings().sonarr.url, "http://192.168.1.99:8989", "nothing was saved");
  updateSettings({ radarr: { url: "http://radarr:7878" }, externalUrl: "https://tastearr.example.com/" });
  assert.equal(getSettings().radarr.url, "http://radarr:7878");
  assert.equal(getSettings().externalUrl, "https://tastearr.example.com");
});

test("an old bad address doesn't block saving other settings", () => {
  patchSettings((s) => ({ ...s, media: { ...s.media, url: "http://169.254.1.1" } }));
  updateSettings({ notify: { picks: 12 } });
  assert.equal(getSettings().notify.picks, 12);
});

test("isMasked recognises the mask and mangled copies, not real keys", () => {
  assert.equal(isMasked(MASK), true);
  assert.equal(isMasked("••••"), true);
  assert.equal(isMasked("abc123"), false);
  assert.equal(isMasked(undefined), false);
});

test("safeEqual", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false);
  assert.equal(safeEqual(undefined, "abc"), false);
  assert.equal(safeEqual("", ""), false);
  assert.equal(safeEqual(["abc"] as unknown as string, "abc"), false);
});

test("passwords are salted scrypt hashes; setting one rotates the session secret", async () => {
  const secret = getSettings().secret;
  await setAccount("owner", "correct horse");
  const s = getSettings();
  assert.notEqual(s.secret, secret);
  assert.ok(!s.auth.passwordHash.includes("correct horse"));
  assert.equal(await checkPassword("correct horse", s.auth.passwordHash), true);
  assert.equal(await checkPassword("wrong", s.auth.passwordHash), false);
  assert.equal(await checkPassword("x", ""), false);
});
