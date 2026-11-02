import type { FastifyInstance } from "fastify";
import { safeEqual } from "../../core/secrets.js";
import { invalidateContext } from "../../services/context.js";
import { noteLegacyWebhook, noteWebhook } from "../../services/health.js";
import { radarrImportList, sonarrImportList } from "../../services/importlists.js";
import { verifyAction } from "../../services/sessions.js";
import { getSettings } from "../../services/settings.js";
import { dropShow } from "../../services/shows.js";
import { handleRadarrWebhook, handleSonarrWebhook } from "../../services/webhooks.js";
import { fail, id } from "../util.js";

type SonarrEvent = Parameters<typeof handleSonarrWebhook>[0];
type RadarrEvent = Parameters<typeof handleRadarrWebhook>[0];

/** Calls from Sonarr/Radarr and phone alert buttons. Each checks its own credentials (webhook key or signed link). */
export function incomingRoutes(app: FastifyInstance) {
  const keyOk = (key: string | undefined) => safeEqual(key, getSettings().webhookKey);

  // v0.1 webhook address (?apikey=<key>). Still works with the webhook key so upgrades don't silently lose alerts (with a
  // warning until Sonarr is pointed at the new address); the admin key is no longer accepted in a URL.
  app.post<{ Querystring: { apikey?: string } }>("/api/webhook/sonarr", { config: { public: true } }, async (req) => {
    if (safeEqual(req.query.apikey, getSettings().apiKey)) {
      noteLegacyWebhook();
      throw fail("Bad webhook key", 401); // the in-app banner explains the new address
    }
    if (!keyOk(req.query.apikey)) throw fail("Bad webhook key", 401);
    noteLegacyWebhook();
    app.log.warn("Sonarr is using the old v0.1 webhook address. Update it to the one shown in Settings → Alerts.");
    return { sent: await handleSonarrWebhook(req.body as SonarrEvent) };
  });
  app.post<{ Params: { key: string } }>("/api/webhook/sonarr/:key", { config: { public: true } }, async (req) => {
    if (!keyOk(req.params.key)) throw fail("Bad webhook key", 401);
    noteWebhook("sonarr");
    return { sent: await handleSonarrWebhook(req.body as SonarrEvent) };
  });
  app.post<{ Params: { key: string } }>("/api/webhook/radarr/:key", { config: { public: true } }, async (req) => {
    if (!keyOk(req.params.key)) throw fail("Bad webhook key", 401);
    noteWebhook("radarr");
    return { sent: await handleRadarrWebhook(req.body as RadarrEvent) };
  });

  // Import lists: Sonarr's and Radarr's "Custom List" read the shows given a thumbs-up or heart on the Picks page.
  app.get<{ Params: { key: string } }>("/api/importlist/sonarr/:key", { config: { public: true } }, async (req) => {
    if (!keyOk(req.params.key)) throw fail("Bad key", 401);
    return sonarrImportList();
  });
  app.get<{ Params: { key: string } }>("/api/importlist/radarr/:key", { config: { public: true } }, async (req) => {
    if (!keyOk(req.params.key)) throw fail("Bad key", 401);
    return radarrImportList();
  });

  app.post<{ Params: { tvdbId: string }; Querystring: { exp?: string; sig?: string } }>(
    "/api/actions/drop/:tvdbId",
    { config: { public: true } },
    async (req) => {
      const tvdbId = id(req.params.tvdbId);
      if (!verifyAction("drop", tvdbId, Number(req.query.exp), String(req.query.sig ?? ""))) throw fail("This link has expired", 401);
      const r = await dropShow(tvdbId);
      invalidateContext();
      return { ok: true, message: `Dropped ${r.title}. You won't get alerts for it any more.` };
    },
  );
}
