import "./env.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { pendingAlert, pendingAlerts } from "../server/data/alerts.js";
import { db } from "../server/data/db.js";
import { ALERT_BATCH, flushPending, handleSonarrWebhook, resumePendingAlerts } from "../server/services/webhooks.js";
import { patchSettings } from "../server/services/settings.js";
import { json, mockFetch, sleep } from "./helpers.ts";

/** Batched "new episode" alerts: persisted so a crash doesn't lose them, sent once, retried on failure. */

const quiet = async <T>(fn: () => Promise<T>) => {
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    return await fn();
  } finally {
    console.warn = warn;
  }
};

patchSettings((s) => ({
  ...s,
  notify: { ...s.notify, episodeAlerts: true, discordWebhook: "", gotifyUrl: "", gotifyToken: "", ntfyUrl: "https://ntfy.sh/alerts" },
}));

const series = (tvdbId: number, title = `Show ${tvdbId}`) => ({
  title,
  tvdbId,
  type: "anime",
  images: [{ coverType: "poster", remoteUrl: "https://img.example/p.jpg" }],
});
const ep = (e: number, s = 1) => ({ seasonNumber: s, episodeNumber: e });
const download = (tvdbId: number, eps: { seasonNumber: number; episodeNumber: number }[]) =>
  handleSonarrWebhook({ eventType: "Download", series: series(tvdbId), episodes: eps });

test("a batch queued by a process that is then killed (SIGKILL, no shutdown) is sent by the next start", async () => {
  const webhooks = pathToFileURL(path.resolve("server/services/webhooks.ts")).href;
  const code = `
    const w = await import(${JSON.stringify(webhooks)});
    await w.handleSonarrWebhook({ eventType: "Download", series: { title: "Crash Saga", tvdbId: 4242, type: "anime" },
      episodes: [{ seasonNumber: 2, episodeNumber: 7 }] });
    process.stdout.write("queued\\n");
    setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ["--no-warnings", "--import", "tsx", "--input-type=module", "-e", code], {
    env: { ...process.env },
    stdio: ["ignore", "pipe", "inherit"],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      let out = "";
      child.stdout.on("data", (d: Buffer) => {
        out += d.toString();
        if (out.includes("queued")) resolve();
      });
      child.on("exit", (c) => reject(new Error(`child exited early (${c})`)));
      setTimeout(() => reject(new Error("child timed out")), 30_000).unref();
    });
  } finally {
    child.kill("SIGKILL");
  }
  await new Promise((r) => child.once("exit", r));

  // This process never saw the webhook: only the database knows about it.
  assert.ok(pendingAlert(4242), "the batch survived the kill");
  assert.deepEqual(
    pendingAlerts().map((a) => a.tvdbId),
    [4242],
  );
  const m = mockFetch((u) => (u.hostname === "ntfy.sh" ? json({ id: "1" }) : undefined));
  try {
    assert.equal(await flushPending(), 1);
    // (The other call is the poster lookup's mapping download, unmocked here: the alert goes out without a poster.)
    const sent = m.calls.filter((c) => c.url.startsWith("https://ntfy.sh"));
    assert.equal(sent.length, 1);
    assert.match((sent[0].body as { title: string }).title, /Crash Saga/);
    assert.match((sent[0].body as { message: string }).message, /S02E07/);
    assert.equal(pendingAlert(4242), null, "removed once sent");
    assert.equal(await flushPending(), 0, "not sent twice");
  } finally {
    m.restore();
  }
});

test("on start, batches left in the database are re-armed and sent after the start delay", async () => {
  await download(500, [ep(1)]);
  const saved = { ...ALERT_BATCH };
  Object.assign(ALERT_BATCH, { startDelayMs: 20 });
  // The process died before the batch's timer fired: it was due long ago.
  db.prepare("UPDATE pending_alerts SET due_at = ? WHERE tvdb_id = 500").run(Date.now() - 3_600_000);
  const m = mockFetch((u) => (u.hostname === "ntfy.sh" ? json({ id: "1" }) : undefined));
  try {
    assert.equal(resumePendingAlerts(), 1);
    assert.equal(m.calls.length, 0, "not before the start delay");
    for (let i = 0; i < 100 && pendingAlert(500); i++) await sleep(10);
    assert.equal(m.calls.length, 1);
    assert.equal(pendingAlert(500), null);
  } finally {
    Object.assign(ALERT_BATCH, saved);
    m.restore();
  }
});

test("Sonarr re-sending the same episode doesn't repeat it in the alert; bad episode entries are ignored", async () => {
  await download(600, [ep(1), ep(2)]);
  await download(600, [ep(2), ep(1)]);
  await handleSonarrWebhook({
    eventType: "Download",
    series: series(600),
    episodes: [{ seasonNumber: 1 } as never, null as never, ep(3)],
  });
  assert.deepEqual(
    pendingAlert<unknown, { seasonNumber: number; episodeNumber: number }>(600)!.episodes.map((e) => e.episodeNumber),
    [1, 2, 3],
  );
  const m = mockFetch((u) => (u.hostname === "ntfy.sh" ? json({ id: "1" }) : undefined));
  try {
    await flushPending();
    assert.equal(m.calls.length, 1);
    assert.equal((m.calls[0].body as { title: string }).title, "3 new episodes: Show 600");
  } finally {
    m.restore();
  }
});

test("a failed send keeps the batch for a retry, and gives up after maxAttempts instead of retrying forever", async () => {
  await download(700, [ep(5)]);
  const m = mockFetch((u) => (u.hostname === "ntfy.sh" ? new Response("down", { status: 502 }) : undefined));
  try {
    await quiet(() => flushPending());
    const a = pendingAlert(700);
    assert.ok(a, "still queued after the first failure");
    assert.equal(a.attempts, 1);
    assert.ok(a.dueAt > Date.now() + ALERT_BATCH.retryMs - 5_000, "retry pushed back");
    for (let i = 1; i < ALERT_BATCH.maxAttempts; i++) await quiet(() => flushPending());
    assert.equal(pendingAlert(700), null, "dropped after the last attempt");
    assert.equal(m.calls.length, ALERT_BATCH.maxAttempts);
  } finally {
    m.restore();
  }
});

test("a flush from the timer and one from shutdown at the same moment send the batch once", async () => {
  await download(800, [ep(1)]);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const m = mockFetch(async (u) => {
    if (u.hostname !== "ntfy.sh") return undefined;
    await gate;
    return json({ id: "1" });
  });
  try {
    const a = flushPending();
    const b = flushPending();
    await sleep(10);
    release();
    await Promise.all([a, b]);
    assert.equal(m.calls.length, 1);
    assert.equal(pendingAlert(800), null);
  } finally {
    m.restore();
  }
});

test("episodes that arrive while a batch is being sent stay queued for the next alert", async () => {
  await download(900, [ep(1)]);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const m = mockFetch(async (u) => {
    if (u.hostname !== "ntfy.sh") return undefined;
    await gate;
    return json({ id: "1" });
  });
  try {
    const flushing = flushPending();
    await sleep(10);
    await download(900, [ep(2)]);
    release();
    await flushing;
    const rest = pendingAlert<unknown, { seasonNumber: number; episodeNumber: number }>(900);
    assert.ok(rest, "the late episode wasn't deleted with the sent batch");
    assert.deepEqual(
      rest.episodes.map((e) => e.episodeNumber),
      [2],
    );
    await flushPending();
    assert.equal(m.calls.length, 2);
    assert.match((m.calls[1].body as { message: string }).message, /S01E02/);
    assert.equal(pendingAlerts().length, 0);
  } finally {
    m.restore();
  }
});

test("with no alert channel set up, a batch is cleared rather than kept forever", async () => {
  await download(950, [ep(1)]);
  patchSettings((s) => ({ ...s, notify: { ...s.notify, ntfyUrl: "" } }));
  try {
    await flushPending();
    assert.equal(pendingAlert(950), null);
  } finally {
    patchSettings((s) => ({ ...s, notify: { ...s.notify, ntfyUrl: "https://ntfy.sh/alerts" } }));
  }
});
