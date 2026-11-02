import type { FastifyInstance } from "fastify";
import type { ShowsResponse } from "../../../shared/api.js";
import { invalidateContext } from "../../services/context.js";
import { followedShows } from "../../services/following.js";
import { getSettings } from "../../services/settings.js";
import { dropShow, myShows, undropShow } from "../../services/shows.js";
import { id } from "../util.js";

/** My Shows: Sonarr series with progress, the follow list, and "not into it anymore". */
export function showsRoutes(app: FastifyInstance) {
  app.get("/api/shows", async (): Promise<ShowsResponse> => ({
    sonarr: getSettings().sonarr.url ? await myShows() : [],
    following: await followedShows(),
  }));
  app.post<{ Params: { tvdbId: string } }>("/api/shows/:tvdbId/drop", async (req) => {
    const r = await dropShow(id(req.params.tvdbId));
    invalidateContext();
    return r;
  });
  app.post<{ Params: { tvdbId: string } }>("/api/shows/:tvdbId/undrop", async (req) => {
    const r = await undropShow(id(req.params.tvdbId));
    invalidateContext();
    return r;
  });
}
