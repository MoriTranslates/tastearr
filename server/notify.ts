import { db } from "./db.js";
import type { Season } from "./anilist.js";
import { getSettings } from "./settings.js";
import { recommend } from "./taste.js";

export interface Message {
  title: string;
  body: string;
  /** Opened when the notification is tapped. */
  url?: string;
  image?: string | null;
  /** Buttons that POST to a URL (ntfy only). */
  actions?: { label: string; url: string }[];
}

async function check(res: Response, who: string) {
  if (!res.ok) throw new Error(`${who} failed (HTTP ${res.status})`);
}

async function sendDiscord(webhook: string, m: Message) {
  const embed = { title: m.title, description: m.body, url: m.url, color: 0x8b5cf6, thumbnail: m.image ? { url: m.image } : undefined };
  await check(await fetch(webhook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "Tastearr", embeds: [embed] }), signal: AbortSignal.timeout(20_000) }), "Discord");
}

async function sendNtfy(topicUrl: string, token: string, m: Message) {
  const u = new URL(topicUrl);
  const body = {
    topic: u.pathname.replace(/^\/+/, ""),
    title: m.title,
    message: m.body,
    click: m.url,
    attach: m.image ?? undefined,
    tags: ["tv"],
    actions: m.actions?.map((a) => ({ action: "http", label: a.label, url: a.url, method: "POST", clear: true })),
  };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  await check(await fetch(u.origin, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) }), "ntfy");
}

async function sendGotify(url: string, token: string, m: Message) {
  const body = {
    title: m.title,
    message: m.body,
    priority: 5,
    extras: { "client::notification": { click: m.url ? { url: m.url } : undefined, bigImageUrl: m.image ?? undefined } },
  };
  await check(
    await fetch(`${url.replace(/\/+$/, "")}/message`, { method: "POST", headers: { "Content-Type": "application/json", "X-Gotify-Key": token }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) }),
    "Gotify",
  );
}

/** Sends to every configured channel. Returns the channels that worked; throws only if all failed. */
export async function send(m: Message) {
  const n = getSettings().notify;
  const jobs: [string, () => Promise<void>][] = [];
  if (n.discordWebhook) jobs.push(["discord", () => sendDiscord(n.discordWebhook, m)]);
  if (n.ntfyUrl) jobs.push(["ntfy", () => sendNtfy(n.ntfyUrl, n.ntfyToken, m)]);
  if (n.gotifyUrl && n.gotifyToken) jobs.push(["gotify", () => sendGotify(n.gotifyUrl, n.gotifyToken, m)]);
  if (!jobs.length) return [];
  const results = await Promise.allSettled(jobs.map(([, f]) => f()));
  const ok = jobs.filter((_, i) => results[i].status === "fulfilled").map(([name]) => name);
  const errors = results.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => (r.reason as Error).message);
  if (errors.length) console.warn("Notification errors:", errors.join("; "));
  if (!ok.length) throw new Error(errors.join("; "));
  return ok;
}

const cap = (s: string) => s[0] + s.slice(1).toLowerCase();

/** Sends the top picks for a season once. Returns true if a message was sent. */
export async function notifySeason(season: Season, year: number, force = false) {
  const n = getSettings().notify;
  if (!force && (!n.seasonAlerts || db.prepare("SELECT 1 FROM notified WHERE season = ? AND year = ?").get(season, year))) return false;
  const { picks } = await recommend(season, year);
  const top = picks.filter((p) => !p.excluded && !p.inLibrary && !p.verdict).slice(0, n.picks);
  if (top.length < Math.min(n.picks, 5)) return false; // season line-up not announced yet
  const ext = getSettings().externalUrl;
  const sent = await send({
    title: `Your ${cap(season)} ${year} anime picks`,
    body: top.map((p, i) => `${i + 1}. ${p.title} (${p.match}%)${p.similar ? ` · like ${p.similar}` : ""}`).join("\n"),
    url: ext ? `${ext}/?season=${season}&year=${year}` : top[0].siteUrl,
    image: top[0].cover,
  });
  if (sent.length) db.prepare("INSERT OR IGNORE INTO notified (season, year) VALUES (?, ?)").run(season, year);
  return sent.length > 0;
}
