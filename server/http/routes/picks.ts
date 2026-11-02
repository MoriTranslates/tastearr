import type { FastifyInstance } from "fastify";
import type { PicksResponse } from "../../../shared/api.js";
import { seasonOf, shiftSeason } from "../../core/taste/media.js";
import { addPick, matchCandidates, monitorPick, planForPick } from "../../services/adding.js";
import { autoAddCandidates, autoAddHistory, runAutoAdd } from "../../services/autoadd.js";
import { getMediaByIds } from "../../services/catalog.js";
import { invalidateContext } from "../../services/context.js";
import { follow, followedIds, unfollow } from "../../services/following.js";
import { recommend, setFeedback } from "../../services/picks.js";
import { getSettings } from "../../services/settings.js";
import { fail, id, monitorChoice, optionalBool, parseSeason } from "../util.js";

const VERDICTS = [null, "loved", "liked", "meh", "disliked", "hidden", "added"];

/** A season's picks and everything done from a pick card: add, monitor, rate, follow; plus auto-add. */
export function picksRoutes(app: FastifyInstance) {
  app.get<{ Querystring: Record<string, string | undefined> }>("/api/picks", async (req): Promise<PicksResponse> => {
    const { season, year } = parseSeason(req.query);
    const r = await recommend(season, year, req.query.refresh === "1");
    const following = new Set(followedIds());
    return { season, year, ...r, picks: r.picks.map((p) => ({ ...p, following: following.has(p.id) })) };
  });

  /** What "Add" will do, shown in the confirm dialog before anything is written to Sonarr/Radarr. */
  app.get<{ Params: { id: string }; Querystring: { tvdbId?: string; season?: string } }>("/api/picks/:id/plan", async (req) => {
    return planForPick(id(req.params.id), req.query.tvdbId, req.query.season);
  });

  /** Sonarr title-search candidates when the community mapping has no TVDB match yet. */
  app.get<{ Params: { id: string } }>("/api/picks/:id/candidates", async (req) => matchCandidates(id(req.params.id)));

  app.post<{ Params: { id: string }; Body: { monitor?: string; search?: boolean; tvdbId?: number; season?: number | null } }>(
    "/api/picks/:id/add",
    async (req) => {
      const anilistId = id(req.params.id);
      const b = req.body;
      return addPick(anilistId, {
        monitor: monitorChoice(b?.monitor),
        search: optionalBool(b?.search),
        tvdbId: b?.tvdbId,
        season: b?.season,
      });
    },
  );
  app.post<{ Params: { id: string }; Body: { search?: boolean } }>("/api/picks/:id/monitor", async (req) =>
    monitorPick(id(req.params.id), optionalBool(req.body?.search)),
  );
  app.post<{ Body: { id: number; verdict: string | null; source?: string } }>("/api/feedback", async (req) => {
    const anilistId = id(String(req.body?.id));
    const verdict = req.body?.verdict ?? null;
    if (!VERDICTS.includes(verdict)) throw fail("Bad verdict");
    if (verdict) await getMediaByIds([anilistId]);
    setFeedback(anilistId, verdict, req.body?.source === "quiz" ? "quiz" : "picks");
    return { ok: true, verdict };
  });

  // Auto-add: what it would do now (read-only), what it did, and a "run now".
  app.get("/api/autoadd/preview", async () => {
    const cur = seasonOf();
    const out = [];
    for (const { season, year } of [cur, shiftSeason(cur, 1)])
      for (const p of await autoAddCandidates(season, year))
        out.push({
          id: p.id,
          title: p.title,
          match: p.match,
          season,
          year,
          action: p.section === "movies" ? "Radarr" : p.autoAction === "monitor" ? `Sonarr, season ${p.tvdbSeason}` : "Sonarr",
        });
    return { enabled: getSettings().autoAdd.enabled, picks: out };
  });
  app.get("/api/autoadd/history", async () => autoAddHistory());
  app.post("/api/autoadd/run", async () => {
    if (!getSettings().autoAdd.enabled) throw fail("Turn auto-add on first");
    return { added: await runAutoAdd() };
  });

  app.post<{ Params: { id: string } }>("/api/picks/:id/follow", async (req) => {
    const r = await follow(id(req.params.id));
    invalidateContext();
    return r;
  });
  app.post<{ Params: { id: string } }>("/api/picks/:id/unfollow", async (req) => unfollow(id(req.params.id)));
}
