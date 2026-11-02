import "../env.ts";
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { sendDiscord, sendGotify, sendNtfy } from "../../server/adapters/notify.js";
import { fakeServer, hang, reply, shortTimeouts, type Handler } from "./fake-server.ts";

let mode: Handler = (_r, res) => reply(res, 200, {});
let srv: Awaited<ReturnType<typeof fakeServer>>;
let restore: () => void;
before(async () => {
  srv = await fakeServer((req, res) => mode(req, res));
  restore = shortTimeouts();
});
after(async () => {
  restore();
  await srv.close();
});
const msg = {
  title: "葬送のフリーレン: episode 5 is out",
  body: 'Aired in Japan & "soon" on Crunchyroll',
  url: "https://x.example/a?b=1&c=2",
  image: "https://i.example/p.jpg",
};
type M = { title: string; body: string; url?: string; image?: string | null };

const channels: Record<string, (m?: M) => Promise<void>> = {
  Discord: (m = msg) => sendDiscord(`${srv.url}/api/webhooks/1/abc`, m),
  ntfy: (m = msg) => sendNtfy(`${srv.url}/alerts`, "tk", m),
  Gotify: (m = msg) => sendGotify(srv.url, "gk", m),
};

describe("every channel", () => {
  for (const [name, send] of Object.entries(channels)) {
    test(`${name}: success, then 401 / 404 / 429 / 5xx / timeout all fail loudly`, async () => {
      mode = (_r, res) => reply(res, 200, {});
      await send();
      for (const code of [401, 404, 429, 500, 503]) {
        mode = (_r, res) => reply(res, code, { error: "no" }, code === 429 ? { "Retry-After": "30" } : {});
        await assert.rejects(send(), new RegExp(`${name} failed \\(HTTP ${code}\\)`));
      }
      mode = hang;
      await assert.rejects(send(), (e: Error) => /abort|timeout/i.test(e.name + e.message));
    });

    test(`${name}: CJK, quotes and ampersands survive the JSON body`, async () => {
      mode = (_r, res) => reply(res, 200, {});
      await send();
      const s = srv.seen.at(-1)!;
      const parsed = JSON.parse(s.body);
      assert.ok(JSON.stringify(parsed).includes("葬送のフリーレン"));
      assert.ok(JSON.stringify(parsed).includes('\\"soon\\"'));
      assert.ok(s.headers["content-type"]!.startsWith("application/json"));
    });

    test(`${name}: an empty message still sends`, async () => {
      mode = (_r, res) => reply(res, 200, {});
      await send({ title: "", body: "" });
      assert.equal(srv.seen.at(-1)!.method, "POST");
    });
  }
});

describe("channel specifics", () => {
  test("Discord: embed shape", async () => {
    mode = (_r, res) => reply(res, 204, "");
    await channels.Discord();
    const b = JSON.parse(srv.seen.at(-1)!.body);
    assert.equal(b.embeds[0].title, msg.title);
    assert.equal(b.embeds[0].thumbnail.url, msg.image);
  });

  test("ntfy: topic in the body, bearer token only when set, buttons become http actions", async () => {
    mode = (_r, res) => reply(res, 200, {});
    await sendNtfy(`${srv.url}/alerts`, "", { ...msg, actions: [{ label: "Add", url: "http://x/add" }] });
    let s = srv.seen.at(-1)!;
    assert.equal(s.path, "/");
    assert.equal(s.headers.authorization, undefined);
    const b = JSON.parse(s.body);
    assert.equal(b.topic, "alerts");
    assert.deepEqual(b.actions[0], { action: "http", label: "Add", url: "http://x/add", method: "POST", clear: true });
    await sendNtfy(`${srv.url}/alerts`, "secret", msg);
    s = srv.seen.at(-1)!;
    assert.equal(s.headers.authorization, "Bearer secret");
  });

  test("Gotify: key header, trailing slashes tolerated", async () => {
    mode = (_r, res) => reply(res, 200, {});
    await sendGotify(`${srv.url}///`, "gk", msg);
    const s = srv.seen.at(-1)!;
    assert.equal(s.path, "/message");
    assert.equal(s.headers["x-gotify-key"], "gk");
  });

  test("bad or metadata addresses are refused without a request", async () => {
    const n = srv.seen.length;
    await assert.rejects(sendDiscord("http://169.254.169.254/x", msg), /isn't allowed/);
    await assert.rejects(sendNtfy("not a url", "", msg), /valid URL/);
    await assert.rejects(sendGotify("file:///etc/passwd", "k", msg), /http/);
    assert.equal(srv.seen.length, n);
  });
});
