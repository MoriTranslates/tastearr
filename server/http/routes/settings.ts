import type { FastifyInstance } from "fastify";
import type { PublicSettings } from "../../../shared/api.js";
import { userFacing } from "../../core/errors.js";
import { checkOutbound } from "../../core/outbound.js";
import { isMasked, type Settings } from "../../core/settings.js";
import { invalidateContext } from "../../services/context.js";
import { discover, useDiscovered } from "../../services/discover.js";
import { refreshLists } from "../../services/lists.js";
import {
  checkPlexSignIn,
  choosePlexServer,
  listJellyfinUsers,
  listLibraries,
  startPlexSignIn,
  testMediaServer,
} from "../../services/mediaserver.js";
import { send } from "../../services/notify.js";
import { rebuildProfile } from "../../services/profile.js";
import { radarrOptions, testRadarr } from "../../services/radarr.js";
import { getSettings, patchSettings, publicSettings, regenerateKey, updateSettings } from "../../services/settings.js";
import { forgetSeries, sonarrOptions, testSonarr } from "../../services/sonarr.js";
import { authState } from "../auth.js";
import { fail, id, withSecret } from "../util.js";

/** Settings, API keys and connections (Sonarr, Radarr, Plex/Jellyfin, alerts, lists). */
export function settingsRoutes(app: FastifyInstance) {
  app.get("/api/settings", async (): Promise<PublicSettings> => publicSettings());
  app.put<{ Body: Partial<Settings> }>("/api/settings", async (req): Promise<PublicSettings> => {
    updateSettings(req.body);
    invalidateContext();
    return publicSettings();
  });

  app.get("/api/settings/keys", async (req) => {
    const s = getSettings();
    // The admin key is only shown to a logged-in session, never via the local-network bypass.
    return { apiKey: authState(req).via === "session" ? s.apiKey : null, webhookKey: s.webhookKey };
  });
  app.post<{ Params: { which: string } }>("/api/settings/keys/:which/regenerate", async (req) => {
    if (req.params.which !== "apiKey" && req.params.which !== "webhookKey") throw fail("Unknown key");
    if (req.params.which === "apiKey" && authState(req).via !== "session") throw fail("Log in to manage the API key", 403);
    return { [req.params.which]: regenerateKey(req.params.which) };
  });

  // Extra Sonarr instances (read for "In library" and monitoring). Added here so their keys never round-trip the browser.
  app.post<{ Body: { name?: string; url?: string; apiKey?: string } }>("/api/sonarr/extra", async (req) => {
    const s = getSettings();
    if (s.sonarrExtra.length >= 4) throw fail("Up to four extra Sonarr instances");
    const url = checkOutbound(
      String(req.body?.url ?? "")
        .trim()
        .replace(/\/+$/, ""),
    );
    const apiKey = String(req.body?.apiKey ?? "").trim();
    if (!apiKey || isMasked(apiKey)) throw fail("Paste that Sonarr's API key");
    if (url === s.sonarr.url || s.sonarrExtra.some((x) => x.url === url)) throw fail("That Sonarr is already connected");
    const v = await testSonarr({ url, apiKey });
    const name =
      String(req.body?.name ?? "")
        .trim()
        .slice(0, 40) || new URL(url).host;
    patchSettings((x) => ({ ...x, sonarrExtra: [...x.sonarrExtra, { name, url, apiKey }] }));
    forgetSeries();
    invalidateContext();
    return { ok: true, version: v.version };
  });
  app.delete<{ Params: { i: string } }>("/api/sonarr/extra/:i", async (req) => {
    const i = Number(req.params.i);
    if (!Number.isInteger(i) || i < 0 || i >= getSettings().sonarrExtra.length) throw fail("That Sonarr isn't connected", 404);
    patchSettings((x) => ({ ...x, sonarrExtra: x.sonarrExtra.filter((_, k) => k !== i) }));
    forgetSeries();
    invalidateContext();
    return { ok: true };
  });

  app.get("/api/discover", async () => discover());
  app.post<{ Body: { id: string; url: string } }>("/api/discover/use", async (req) => {
    // Every error useDiscovered throws is about what was asked for (stale id, bad or off-network address): a 400, not a 500.
    const r = await userFacing(() =>
      useDiscovered(String(req.body?.id ?? ""), String(req.body?.url ?? ""), authState(req).via === "session"),
    );
    invalidateContext();
    return r;
  });

  app.post<{ Body: { url?: string; apiKey?: string } }>("/api/sonarr/test", async (req) => {
    const s = getSettings().sonarr;
    const c = withSecret(req.body?.url, req.body?.apiKey, s.url, s.apiKey);
    const conn = { url: c.url, apiKey: c.secret };
    return { ...(await testSonarr(conn)), options: await sonarrOptions(conn) };
  });
  app.post<{ Body: { url?: string; apiKey?: string } }>("/api/radarr/test", async (req) => {
    const s = getSettings().radarr;
    const c = withSecret(req.body?.url, req.body?.apiKey, s.url, s.apiKey);
    const conn = { url: c.url, apiKey: c.secret };
    return { ...(await testRadarr(conn)), options: await radarrOptions(conn) };
  });

  const mediaConn = (b: Partial<Settings["media"]> | undefined): Settings["media"] => {
    const cur = getSettings().media;
    const type = b?.type === "plex" || b?.type === "jellyfin" ? b.type : cur.type;
    const c = withSecret(b?.url ?? cur.url, b?.token, cur.url, cur.token);
    return { ...cur, type, url: c.url, token: c.secret, userId: String(b?.userId ?? cur.userId) };
  };
  app.post<{ Body: Partial<Settings["media"]> }>("/api/media/test", async (req) => {
    const conn = mediaConn(req.body);
    const info = await testMediaServer(conn);
    const users = conn.type === "jellyfin" ? await listJellyfinUsers(conn) : [];
    const libraries = conn.type === "plex" || conn.userId ? await listLibraries(conn).catch(() => []) : [];
    return { ...info, users, libraries };
  });

  // "Sign in with Plex": the account token stays on the server; the browser only ever sees server names and URLs.
  app.post("/api/plex/pin", async () => startPlexSignIn());
  app.get<{ Params: { id: string } }>("/api/plex/pin/:id", async (req) => checkPlexSignIn(id(req.params.id)));
  app.post<{ Body: { pinId: number; serverId: string; url: string } }>("/api/plex/server", async (req) => {
    const r = await choosePlexServer(Number(req.body?.pinId), req.body?.serverId, String(req.body?.url ?? ""));
    invalidateContext();
    return r;
  });

  app.post("/api/notify/test", async () => ({ sent: await send({ title: "Tastearr test", body: "Alerts are working 🎉" }) }));

  app.post("/api/lists/import", async () => {
    const done = await refreshLists();
    invalidateContext();
    void rebuildProfile().catch(() => undefined);
    return { imported: done };
  });
}
