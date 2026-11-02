/**
 * Import this first in a web test: it gives the file a browser-like global scope (happy-dom) before React loads, and
 * puts a recording fake of the Tastearr API in place of `fetch`. Nothing touches the disk or the network.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { after, afterEach } from "node:test";

GlobalRegistrator.register({ url: "http://localhost:8383/", width: 1280, height: 900 });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// A busy CI machine should not turn a slow render into a failure (a passing test never waits this long).
const { configure } = await import("@testing-library/dom");
configure({ asyncUtilTimeout: 5000 });

export interface ApiCall {
  method: string;
  path: string;
  body: unknown;
}
export type ApiHandler = (call: ApiCall) => unknown;

/** A fake backend: `routes` maps "METHOD /path" (no query string) to a value (JSON-encoded) or a function. */
export function fakeApi(routes: Record<string, unknown | ApiHandler>) {
  const calls: ApiCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input), "http://localhost:8383");
    const method = (init.method ?? "GET").toUpperCase();
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    const call = { method, path: url.pathname.replace(/^\/api/, "") + url.search, body };
    calls.push(call);
    const key = `${method} ${url.pathname.replace(/^\/api/, "")}`;
    const hit = routes[key];
    if (hit === undefined) return new Response(JSON.stringify({ error: `No fake for ${key}` }), { status: 404 });
    const out = typeof hit === "function" ? await (hit as ApiHandler)(call) : hit;
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return calls;
}

export const apiError = (status: number, error: string) =>
  new Response(JSON.stringify({ error }), { status, headers: { "Content-Type": "application/json" } });

afterEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
  history.replaceState(null, "", "/");
});
after(async () => {
  await GlobalRegistrator.unregister();
});
