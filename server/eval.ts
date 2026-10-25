/**
 * Offline evaluation: `npm run eval` (uses the database in TASTEARR_CONFIG).
 *
 * For each of the last N seasons X: build a profile from seasons before X only, score X's line-up without looking
 * at anything the user did with those shows ("blind"), and compare with what the user actually kept (in Sonarr
 * with that season monitored or downloaded, or watched in Plex/Jellyfin, or on their list).
 * Prints AUC, precision@20 and R-precision per season and overall. Every taste change should be checked here.
 */
import { getMediaByIds, getSeason, seasonOf, shiftSeason } from "./anilist.js";
import { buildProfile, choseWithFiles, context, labelOf, scoreCandidates } from "./taste.js";

const SEASONS_BACK = Number(process.argv[2] ?? 5);

function auc(scores: number[], labels: boolean[]) {
  const pos = scores.filter((_, i) => labels[i]);
  const neg = scores.filter((_, i) => !labels[i]);
  if (!pos.length || !neg.length) return NaN;
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

const precisionAt = (ranked: boolean[], k: number) => ranked.slice(0, k).filter(Boolean).length / Math.min(k, ranked.length || 1);

async function main() {
  const ctx = await context(true);
  const now = seasonOf();
  const rows: { name: string; n: number; pos: number; auc: number; p20: number; rprec: number }[] = [];
  const all: { score: number; kept: boolean }[] = [];
  // Guard metric: "actually watched" (Plex/Jellyfin progress, a good rating or list score), so tuning can't drift toward
  // shows that are downloaded but never watched. Accept a change only if kept improves and this doesn't drop.
  const watched: { score: number; seen: boolean }[] = [];
  for (let i = SEASONS_BACK; i >= 1; i--) {
    const target = shiftSeason(now, -i);
    const profile = await buildProfile({ until: target, save: false, ctx });
    const list = (await getSeason(target.season, target.year)).filter((m) => !m.isAdult && m.format && ["TV", "TV_SHORT", "ONA"].includes(m.format) && m.countryOfOrigin === "JP");
    // Make sure prequels are cached so the franchise logic works as in production.
    let frontier = [...new Set(list.flatMap((m) => (m.relations?.edges ?? []).filter((e) => e.relationType === "PREQUEL" || e.relationType === "PARENT").map((e) => e.node.id)))];
    for (let depth = 0; depth < 3 && frontier.length; depth++) {
      const got = await getMediaByIds(frontier);
      frontier = [...new Set(got.flatMap((m) => (m.relations?.edges ?? []).filter((e) => e.relationType === "PREQUEL").map((e) => e.node.id)))];
    }
    const picks = scoreCandidates(list, profile, ctx, { blind: true });
    // "Kept" = chose it in Sonarr/Radarr, or a clear positive from watch history / list / ratings.
    // Sonarr auto-monitors new seasons of owned series, so "monitored" alone isn't a choice: it needs files or progress.
    const truth = new Map(list.map((m) => [m.id, choseWithFiles(m.id, ctx) || labelOf(m.id, ctx).p >= 1.2]));
    const ranked = [...picks].sort((a, b) => b.score - a.score);
    const labels = ranked.map((p) => truth.get(p.id) ?? false);
    const pos = labels.filter(Boolean).length;
    ranked.forEach((p, k) => all.push({ score: p.score, kept: labels[k] }));
    for (const p of ranked) watched.push({ score: p.score, seen: labelOf(p.id, ctx).p >= 1.5 });
    rows.push({
      name: `${target.season} ${target.year}`,
      n: list.length,
      pos,
      auc: auc(ranked.map((p) => p.score), labels),
      p20: precisionAt(labels, 20),
      rprec: precisionAt(labels, pos),
    });
  }
  const f = (x: number) => (Number.isNaN(x) ? "  -  " : x.toFixed(3));
  console.log("season         shows  kept   AUC    P@20   R-prec");
  for (const r of rows) console.log(`${r.name.padEnd(14)} ${String(r.n).padStart(5)} ${String(r.pos).padStart(5)}  ${f(r.auc)}  ${f(r.p20)}  ${f(r.rprec)}`);
  const ok = rows.filter((r) => !Number.isNaN(r.auc));
  const avg = (k: "auc" | "p20" | "rprec") => ok.reduce((a, r) => a + r[k], 0) / (ok.length || 1);
  // Calibration: fit P(kept) = sigmoid(a * (score - b)) so "70% match" means about 70% of such shows were kept.
  let a = 1;
  let b = 3;
  for (let it = 0; it < 4000; it++) {
    let ga = 0;
    let gb = 0;
    for (const x of all) {
      const pr = 1 / (1 + Math.exp(-a * (x.score - b)));
      const err = pr - (x.kept ? 1 : 0);
      ga += err * (x.score - b);
      gb += -err * a;
    }
    a -= (0.5 * ga) / all.length;
    b -= (0.5 * gb) / all.length;
  }
  console.log(`calibration: toMatch a=${a.toFixed(2)} b=${b.toFixed(2)} (set TASTEARR_TUNE ma/mb to try)`);
  console.log(`${"overall".padEnd(14)} ${"".padStart(11)}  ${f(avg("auc"))}  ${f(avg("p20"))}  ${f(avg("rprec"))}`);
  const seen = watched.filter((x) => x.seen).length;
  console.log(`watched guard (${seen} watched): AUC ${f(auc(watched.map((x) => x.score), watched.map((x) => x.seen)))}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
