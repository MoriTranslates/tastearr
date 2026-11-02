import { checkOutbound } from "../core/outbound.js";

/** Push notification channels: Discord webhooks, ntfy and Gotify. Each send takes its own address and token. */

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

export async function sendDiscord(webhook: string, m: Message) {
  checkOutbound(webhook, "The Discord webhook");
  const embed = { title: m.title, description: m.body, url: m.url, color: 0x8b5cf6, thumbnail: m.image ? { url: m.image } : undefined };
  await check(
    await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "Tastearr", embeds: [embed] }),
      signal: AbortSignal.timeout(20_000),
    }),
    "Discord",
  );
}

/**
 * ntfy's JSON publishing goes to the server's root with the topic in the body. The root is everything before the topic,
 * so a server behind a path prefix (https://example.com/ntfy/my-topic) keeps its prefix.
 */
export function ntfyTarget(topicUrl: string) {
  const u = new URL(checkOutbound(topicUrl, "The ntfy address"));
  const parts = u.pathname.replace(/\/+$/, "").split("/");
  const topic = parts.pop() ?? "";
  return { endpoint: `${u.origin}${parts.join("/")}/`, topic };
}

export async function sendNtfy(topicUrl: string, token: string, m: Message) {
  const { endpoint, topic } = ntfyTarget(topicUrl);
  const body = {
    topic,
    title: m.title,
    message: m.body,
    click: m.url,
    attach: m.image ?? undefined,
    tags: ["tv"],
    actions: m.actions?.map((a) => ({ action: "http", label: a.label, url: a.url, method: "POST", clear: true })),
  };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  await check(await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) }), "ntfy");
}

export async function sendGotify(url: string, token: string, m: Message) {
  checkOutbound(url, "The Gotify address");
  const body = {
    title: m.title,
    message: m.body,
    priority: 5,
    extras: { "client::notification": { click: m.url ? { url: m.url } : undefined, bigImageUrl: m.image ?? undefined } },
  };
  await check(
    await fetch(`${url.replace(/\/+$/, "")}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Gotify-Key": token },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    }),
    "Gotify",
  );
}
