import type { FastifyInstance } from "fastify";
import { searchTitle } from "../../services/catalog.js";
import { invalidateContext, titleOf } from "../../services/context.js";
import { getQuiz } from "../../services/quiz.js";
import { patchSettings, setGenrePrefs } from "../../services/settings.js";

/** The cold-start quiz: shows to rate, genre/theme answers, content filters. */
export function quizRoutes(app: FastifyInstance) {
  app.get("/api/quiz", async () => getQuiz());
  /** "Add a show you've seen" in the quiz. */
  app.get<{ Querystring: { q?: string } }>("/api/quiz/search", async (req) => {
    const q = String(req.query.q ?? "")
      .trim()
      .slice(0, 80);
    if (q.length < 2) return [];
    return (await searchTitle(q)).map((m) => ({
      id: m.id,
      title: titleOf(m),
      cover: m.coverImage.large,
      year: m.seasonYear ?? m.startDate?.year ?? null,
      format: m.format,
    }));
  });
  app.put<{ Body: { noGore?: boolean } }>("/api/quiz/content", async (req) => {
    patchSettings((s) => ({ ...s, filters: { ...s.filters, noGore: req.body?.noGore === true } }));
    invalidateContext();
    return { ok: true };
  });
  app.put<{ Body: { genrePrefs: unknown } }>("/api/quiz/genres", async (req) => {
    setGenrePrefs(req.body?.genrePrefs);
    return { ok: true };
  });
}
