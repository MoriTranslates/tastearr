import { useCallback, useEffect, useRef, useState } from "react";
import { api, type AddPlan, type Candidate, type Pick } from "../api";
import { Modal, Spinner } from "../components/ui";
import type { CardProps, Mode } from "./types";
import { errorMessage } from "../lib/errors";

/** One preview dialog for every Sonarr/Radarr write: add, add after picking a match, and "get season N". */
export function AddDialog({
  p,
  mode,
  onClose,
  patch,
  toast,
}: {
  p: Pick;
  mode: Mode;
  onClose: () => void;
  patch: CardProps["patch"];
  toast: CardProps["toast"];
}) {
  const [plan, setPlan] = useState<AddPlan | null>(null);
  const [cands, setCands] = useState<Candidate[] | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [match, setMatch] = useState<Candidate | null>(null);
  const [season, setSeason] = useState<number | null>(null);
  const [monitor, setMonitor] = useState<AddPlan["monitor"]>();
  const [search, setSearch] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Only the latest plan request counts (changing the season quickly mustn't let an older answer win).
  const req = useRef(0);
  const loadPlan = useCallback(
    (q = "", keepChoices = false) => {
      const mine = ++req.current;
      setError(null);
      return api<AddPlan>(`/picks/${p.id}/plan${q}`)
        .then((x) => {
          if (mine !== req.current) return;
          setPlan(x);
          if (!keepChoices) {
            setMonitor(x.monitor);
            setSearch(x.search ?? true);
          }
          setSeason(x.season ?? null);
          if (x.needsMatch && !q)
            api<Candidate[]>(`/picks/${p.id}/candidates`)
              .then(setCands)
              .catch((e) => setError(errorMessage(e)));
        })
        .catch((e) => mine === req.current && setError(errorMessage(e)));
    },
    [p.id],
  );
  useEffect(() => {
    // "Get the new season": the series is already matched; ask which season, defaulting to the one after the last listed.
    if (mode === "pick-season" && p.tvdbId) {
      setMatch({
        tvdbId: p.tvdbId,
        title: p.title,
        year: null,
        network: null,
        seasons: [],
        overview: null,
        inLibrary: true,
        confident: true,
      });
      void loadPlan(`?tvdbId=${p.tvdbId}`);
    } else void loadPlan();
  }, [loadPlan, mode, p.tvdbId, p.title]);

  function pick(c: Candidate | null, s: number | null = null) {
    setMatch(c);
    setError(null);
    if (!c) return void loadPlan();
    setPlan(null);
    void loadPlan(`?tvdbId=${c.tvdbId}${s ? `&season=${s}` : ""}`);
  }

  const canSearch =
    monitor === "all" || ((monitor === "season" || mode !== "add" || plan?.alreadyInLibrary) && plan?.seasonListed !== false);
  async function go() {
    setBusy(true);
    try {
      if (mode === "monitor") {
        const r = await api<{ waitingForSeason?: boolean; resumedSeries?: boolean }>(`/picks/${p.id}/monitor`, {
          body: { search: canSearch && search },
        });
        patch(p.id, { seasonMonitored: true, verdict: "added" });
        toast(
          `Season ${p.tvdbSeason} turned on in Sonarr${r.resumedSeries ? " (the series was switched back on too)" : ""}${r.waitingForSeason ? ". TVDB hasn't listed it yet; Sonarr will grab it when it does." : ""}`,
        );
      } else {
        const body =
          plan?.app === "sonarr" ? { monitor, search: canSearch && search, ...(match ? { tvdbId: match.tvdbId, season } : {}) } : {};
        const r = await api<{ title: string; monitored?: string; waitingForSeason?: boolean; alreadyInLibrary?: boolean }>(
          `/picks/${p.id}/add`,
          { body },
        );
        patch(p.id, {
          inLibrary: true,
          seasonMonitored: true,
          verdict: "added",
          needsMatch: false,
          ...(season ? { tvdbSeason: season, matchGuessed: false } : {}),
        });
        toast(
          r.alreadyInLibrary
            ? `${r.title} is already in Sonarr; matched for next time`
            : `${r.title} added to ${plan?.app === "radarr" ? "Radarr" : "Sonarr"}${r.monitored ? ` (${r.monitored.toLowerCase()})` : ""}${r.waitingForSeason ? ". TVDB hasn't listed the new season yet; Sonarr will grab it when it does." : ""}`,
        );
      }
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const choosing = plan?.needsMatch && !match;
  // Only offer a single "Is this it?" when the best result really looks like the show; otherwise list them all.
  const confident = !!cands?.[0]?.confident;
  const [best, ...rest] = cands ?? [];
  const nextSeason = Math.max(0, ...(plan?.seasons ?? [])) + 1;
  return (
    <Modal
      title={
        mode === "monitor"
          ? `Get season ${p.tvdbSeason} of ${p.title}`
          : mode === "pick-season"
            ? `Get the new season of ${p.title}`
            : `Add ${p.title}`
      }
      onClose={onClose}
    >
      {error && <p className="error">{error}</p>}
      {!plan && !error && <Spinner label="Checking with Sonarr…" />}
      {choosing && (
        <>
          <p className="small">
            {confident && !showAll
              ? "The anime database hasn't matched this show to Sonarr yet. Is this it?"
              : "The anime database hasn't matched this show to Sonarr yet, and there's no obvious match. Pick the right one, or none:"}
          </p>
          {!cands && !error && <Spinner label="Searching Sonarr…" />}
          {cands && !cands.length && <p className="muted small">Sonarr couldn't find it either. Try again in a few days.</p>}
          <div className="cand-list">
            {(showAll || !confident ? (cands ?? []) : best ? [best] : []).map((c) => (
              <button key={c.tvdbId} className={`cand${c === best && confident ? " best" : ""}`} onClick={() => pick(c)}>
                <strong>{c.title}</strong>{" "}
                <span className="muted small">
                  {[
                    c.year,
                    c.network,
                    c.seasons.length ? `${c.seasons.length} season${c.seasons.length > 1 ? "s" : ""}` : null,
                    c.inLibrary ? "already in Sonarr" : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                {c.overview && <span className="muted small block clamp2">{c.overview}</span>}
              </button>
            ))}
          </div>
          <div className="row end">
            {confident && !showAll && rest.length > 0 && (
              <button className="ghost small" onClick={() => setShowAll(true)}>
                Not it? Show {rest.length} more
              </button>
            )}
            <button className="ghost" onClick={onClose}>
              None of these
            </button>
          </div>
        </>
      )}
      {!plan && error && match && mode === "add" && (
        <button className="ghost small" onClick={() => pick(null)}>
          Pick a different match
        </button>
      )}
      {plan && !choosing && (
        <div className="stack">
          {plan.app === "sonarr" && (
            <ul className="plan small">
              <li>
                <strong>{plan.title}</strong>
                {plan.year ? ` (${plan.year})` : ""} {plan.alreadyInLibrary ? "is already in Sonarr" : "as an anime series"}
                {match && mode === "add" && (
                  <>
                    {" · "}
                    <button className="linklike small" onClick={() => pick(null)}>
                      Change match
                    </button>
                  </>
                )}
              </li>
              {mode === "add" && !plan.alreadyInLibrary && (
                <>
                  <li>
                    Quality: {plan.profile ?? "not set"} · Folder: {plan.rootFolder}
                  </li>
                  <li>Tags: {plan.tags?.join(", ")}</li>
                </>
              )}
              {mode === "monitor" && (
                <li>
                  Turns on season {p.tvdbSeason}
                  {plan.seasonListed === false ? " (TVDB hasn't listed it yet; Sonarr grabs it when it does)" : ""}. Nothing else changes.
                </li>
              )}
              {plan.resumesSeries && <li className="warn">This series is switched off in Sonarr; this turns it back on.</li>}
            </ul>
          )}
          {plan.app === "sonarr" && match && (plan.seasons?.length ?? 0) > 0 && mode !== "monitor" && (
            <label className="field">
              Which season is this?
              <select
                value={season ?? ""}
                onChange={(e) => {
                  const v = e.target.value ? Number(e.target.value) : null;
                  setSeason(v);
                  void loadPlan(`?tvdbId=${match.tvdbId}${v ? `&season=${v}` : ""}`, true);
                }}
              >
                {mode !== "pick-season" && <option value="">Not sure (only new episodes)</option>}
                {mode === "pick-season" && !season && <option value="">Choose a season…</option>}
                {[...plan.seasons!, nextSeason].map((n) => (
                  <option key={n} value={n}>
                    Season {n}
                    {n === nextSeason ? " (not listed on TVDB yet)" : ""}
                  </option>
                ))}
              </select>
            </label>
          )}
          {plan.app === "sonarr" && mode === "add" && !plan.alreadyInLibrary && (
            <label className="field">
              What to download
              <select value={monitor} onChange={(e) => setMonitor(e.target.value as AddPlan["monitor"])}>
                {(plan.options ?? []).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {plan.app === "sonarr" && (
            <label className="check small">
              <input type="checkbox" checked={canSearch && search} disabled={!canSearch} onChange={(e) => setSearch(e.target.checked)} />{" "}
              Start searching right away
            </label>
          )}
          {plan.app === "radarr" && (
            <ul className="plan small">
              <li>Added to Radarr in {plan.rootFolder}</li>
              <li>{plan.search ? "Radarr will start searching right away." : "Radarr won't search until you ask it to."}</li>
            </ul>
          )}
          <div className="row end">
            <button className="ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="primary" disabled={busy || (mode === "pick-season" && !season)} onClick={go}>
              {busy
                ? "Working…"
                : mode === "monitor"
                  ? `Get season ${p.tvdbSeason}`
                  : plan.alreadyInLibrary
                    ? season
                      ? `Get season ${season}`
                      : "Match it"
                    : "Add"}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
