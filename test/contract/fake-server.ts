import http from "node:http";
import type { AddressInfo } from "node:net";

/** A throwaway local HTTP server standing in for Sonarr, Plex, ntfy and the rest. Handlers get the request and reply. */

export interface Seen {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}
export type Handler = (req: Seen, res: http.ServerResponse) => void | Promise<void>;

export async function fakeServer(handler: Handler) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const s = { method: req.method ?? "GET", path: req.url ?? "/", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
      seen.push(s);
      void Promise.resolve(handler(s, res)).catch(() => res.destroy());
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))),
  };
}

export const reply = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  res.end(text);
};

/** Makes `AbortSignal.timeout` fire after `ms` so a hung server fails a test in milliseconds, not a minute. */
export function shortTimeouts(ms = 150) {
  const real = AbortSignal.timeout;
  AbortSignal.timeout = () => real.call(AbortSignal, ms);
  return () => void (AbortSignal.timeout = real);
}

/** Never answers: for timeout tests. */
export const hang: Handler = () => undefined;
