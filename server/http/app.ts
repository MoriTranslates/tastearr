import fs from "node:fs";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { WEB_DIR } from "../config.js";
import { guard, trustProxyOption } from "./auth.js";
import { accountRoutes } from "./routes/account.js";
import { incomingRoutes } from "./routes/incoming.js";
import { picksRoutes } from "./routes/picks.js";
import { quizRoutes } from "./routes/quiz.js";
import { settingsRoutes } from "./routes/settings.js";
import { showsRoutes } from "./routes/shows.js";
import { systemRoutes } from "./routes/system.js";

/** The Fastify app: logging, the auth guard, error responses, the API route modules and the web UI. */

/** Request URLs in logs without query strings or webhook keys. */
const redact = (url: string) => url.split("?")[0].replace(/(\/api\/(?:webhook|importlist)\/\w+\/)[^/]+/, "$1***");

export const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
    serializers: { req: (r) => ({ method: r.method, url: redact(r.url), remoteAddress: r.ip }) },
  },
  // proxy-addr accepts a hop count too; Fastify's types only list string | string[] | boolean.
  trustProxy: trustProxyOption() as string[] | false,
  bodyLimit: 1_000_000,
});
/** Every route as registered, so tests can check that each one is guarded. */
export const routes: { method: string | string[]; url: string; config: { public?: boolean; setup?: boolean } }[] = [];
app.addHook(
  "onRoute",
  (r) => void routes.push({ method: r.method, url: r.url, config: (r.config ?? {}) as { public?: boolean; setup?: boolean } }),
);
await app.register(fastifyCookie);
app.addHook("onRequest", guard);
app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
  const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
  // fetch's own "can't connect" (from a call that didn't go through safeFetch): an outside service is down, not us.
  const why = status === 500 ? fetchFailure(err) : null;
  if (why) {
    req.log.warn(errorForLog(err), "An outside service couldn't be reached");
    return reply.code(502).send({ error: `An outside service couldn't be reached (${why}). Check that it is running.` });
  }
  if (status === 500 && isInternal(err)) {
    // Node, SQLite or a library speaking, not our own wording: it can carry SQL, file paths or resolver details.
    // The details go to the log (credentials and tokens in URLs removed); the browser gets a reference to find them.
    req.log.error(errorForLog(err), `Internal error (ref ${req.id})`);
    return reply.code(500).send({ error: `Something went wrong on the server. The Tastearr log has the details (ref ${req.id}).` });
  }
  req.log.warn(redactUrls(err.message));
  return reply.code(status).send({ error: err.message });
});

/** "TypeError: fetch failed": the reason from its cause (ECONNREFUSED, ENOTFOUND ...), else null. */
function fetchFailure(err: Error) {
  if (!(err instanceof TypeError) || err.message !== "fetch failed") return null;
  const cause = err.cause as { code?: unknown; message?: unknown } | undefined;
  return String(cause?.code ?? cause?.message ?? "no connection");
}

/** Credentials (`user:pass@`) and token- or key-like query values in any URL in `text`, replaced by ***. */
function redactUrls(text: string) {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, "$1***@")
    .replace(/([?&][^=&\s]*(?:token|key|pass|secret|auth|sig)[^=&\s]*=)[^&\s#]+/gi, "$1***");
}

/**
 * What the log keeps of an error: name, code, message and stack (URLs redacted, cause included the same way). Not the
 * whole object: Node errors carry extra fields such as `input`, the raw URL with any credentials in it.
 */
export function errorForLog(err: unknown, depth = 0): Record<string, unknown> {
  const e = err as Error & { code?: unknown; cause?: unknown };
  const out: Record<string, unknown> = {
    type: e?.name,
    message: redactUrls(String(e?.message ?? err)),
    ...(e?.code !== undefined ? { code: e.code } : {}),
    ...(e?.stack ? { stack: redactUrls(e.stack) } : {}),
  };
  if (e?.cause && depth < 2) out.cause = errorForLog(e.cause, depth + 1);
  return out;
}

/**
 * Errors not written for the user: JavaScript runtime errors (TypeError, RangeError ...) and system or SQLite errors
 * (they carry a `code` such as ENOTFOUND or ERR_SQLITE_ERROR). Our own errors are plain `Error`s or carry a status.
 */
function isInternal(err: Error) {
  if (err instanceof TypeError || err instanceof RangeError || err instanceof ReferenceError || err instanceof SyntaxError) return true;
  return typeof (err as { code?: unknown }).code === "string";
}

/** Docker HEALTHCHECK / Uptime Kuma: no login, no data. */
app.get("/ping", async () => ({ status: "OK" }));

accountRoutes(app);
settingsRoutes(app);
systemRoutes(app);
picksRoutes(app);
quizRoutes(app);
showsRoutes(app);
incomingRoutes(app);

if (fs.existsSync(WEB_DIR)) {
  await app.register(fastifyStatic, { root: WEB_DIR, wildcard: false });
  app.setNotFoundHandler((req, reply) =>
    req.url.startsWith("/api/") ? reply.code(404).send({ error: "Not found" }) : reply.sendFile("index.html"),
  );
}
