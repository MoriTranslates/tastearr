import { useEffect, useMemo, useRef, useState } from "react";
import { api, seasonName, shiftSeason, store, type Pick, type Season, type Section, type Status } from "../api";
import { airLabel, Spinner, usePageTitle, useToast } from "../ui";

const SECTIONS: { id: Section; label: string; hint: string }[] = [
  { id: "continuing", label: "Continuing", hint: "Sequels and shows carrying over from last season" },
  { id: "new", label: "New shows", hint: "First seasons and new series" },
  { id: "shorts", label: "Shorts", hint: "Short-episode series" },
  { id: "movies", label: "Movies", hint: "Films and theatrical releases" },
];
const SORTS = {
  match: { label: "Best match", fn: (a: Pick, b: Pick) => b.score - a.score },
  popularity: { label: "Popularity", fn: (a: Pick, b: Pick) => b.popularity - a.popularity },
  rating: { label: "AniList score", fn: (a: Pick, b: Pick) => (b.averageScore ?? 0) - (a.averageScore ?? 0) },
  airing: { label: "Airing soonest", fn: (a: Pick, b: Pick) => (a.nextAiring?.at ?? Infinity) - (b.nextAiring?.at ?? Infinity) },
  title: { label: "Title", fn: (a: Pick, b: Pick) => a.title.localeCompare(b.title) },
} as const;
type SortKey = keyof typeof SORTS;
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
/** Monday = 0, in the viewer's local time. */
const weekday = (ms: number) => (new Date(ms).getDay() + 6) % 7;

function readQuery(status: Status) {
  const q = new URLSearchParams(location.search);
  const season = q.get("season")?.toUpperCase() as Season | undefined;
  const year = Number(q.get("year"));
  return {
    sel: season && year ? { season, year } : status.season!,
    view: (q.get("view") === "schedule" ? "schedule" : "grid") as "grid" | "schedule",
    day: q.get("day") !== null && q.get("day") !== "" ? Number(q.get("day")) : null,
  };
}

export function Picks({ status }: { status: Status }) {
  const init = useMemo(() => readQuery(status), [status]);
  const toast = useToast();
  const [sel, setSel] = useState(init.sel);
  const [view, setView] = useState(init.view);
  const [day, setDay] = useState<number | null>(init.day);
  const [sort, setSort] = useState<SortKey>(() => store.get("sort", "match"));
  const [services, setServices] = useState<string[]>(() => store.get("services", []));
  const [showLibrary, setShowLibrary] = useState(() => store.get("showLibrary", true));
  const [showFiltered, setShowFiltered] = useState(false);
  const [collapsed, setCollapsed] = useState<Section[]>(() => store.get("collapsed", []));
  const [picks, setPicks] = useState<Pick[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const refresh = useRef(false);
  usePageTitle(`${seasonName(sel.season)} ${sel.year}`);

  useEffect(() => {
    const q = new URLSearchParams({ season: sel.season, year: String(sel.year) });
    if (view === "schedule") q.set("view", "schedule");
    if (day !== null) q.set("day", String(day));
    history.replaceState(null, "", `/?${q}`);
  }, [sel, view, day]);
  useEffect(() => store.set("sort", sort), [sort]);
  useEffect(() => store.set("services", services), [services]);
  useEffect(() => store.set("showLibrary", showLibrary), [showLibrary]);
  useEffect(() => store.set("collapsed", collapsed), [collapsed]);

  useEffect(() => {
    const ctrl = new AbortController();
    setPicks(null);
    setError(null);
    const r = refresh.current ? "&refresh=1" : "";
    refresh.current = false;
    api<{ picks: Pick[] }>(`/picks?season=${sel.season}&year=${sel.year}${r}`, { signal: ctrl.signal })
      .then((x) => setPicks(x.picks))
      .catch((e) => {
        if (!ctrl.signal.aborted) setError((e as Error).message);
      });
    return () => ctrl.abort();
  }, [sel.season, sel.year, reload]);

  const allServices = useMemo(() => [...new Set((picks ?? []).flatMap((p) => p.streaming.map((x) => x.site)))].sort(), [picks]);
  const visible = useMemo(() => {
    const list = (picks ?? []).filter(
      (p) =>
        (showFiltered || !p.excluded) &&
        (showLibrary || !p.inLibrary) &&
        (!services.length || p.streaming.some((x) => services.includes(x.site))) &&
        (day === null || (p.nextAiring && weekday(p.nextAiring.at) === day)),
    );
    return list.sort(SORTS[sort].fn);
  }, [picks, showFiltered, showLibrary, services, day, sort]);
  const hidden = (picks?.length ?? 0) - visible.length;

  function patch(id: number, change: Partial<Pick>) {
    setPicks((list) => list?.map((p) => (p.id === id ? { ...p, ...change } : p)) ?? null);
  }

  return (
    <section>
      <div className="toolbar">
        <div className="season-nav">
          <button onClick={() => setSel(shiftSeason(sel, -1))} aria-label="Previous season">
            ‹
          </button>
          <h1>
            {seasonName(sel.season)} {sel.year}
          </h1>
          <button onClick={() => setSel(shiftSeason(sel, 1))} aria-label="Next season">
            ›
          </button>
        </div>
        <div className="seg" role="radiogroup" aria-label="View">
          {(["grid", "schedule"] as const).map((v) => (
            <button key={v} role="radio" aria-checked={view === v} className={view === v ? "on" : ""} onClick={() => setView(v)}>
              {v === "grid" ? "Picks" : "Schedule"}
            </button>
          ))}
        </div>
      </div>

      <div className="filters">
        <label className="inline">
          Sort
          <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
            {Object.entries(SORTS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>
        </label>
        <div className="chips" role="group" aria-label="Air day">
          {DAYS.map((d, i) => (
            <button key={d} className={`chip${day === i ? " on" : ""}`} aria-pressed={day === i} onClick={() => setDay(day === i ? null : i)}>
              {d}
            </button>
          ))}
        </div>
        {allServices.length > 0 && (
          <div className="chips" role="group" aria-label="Streaming service">
            {allServices.map((sv) => {
              const on = services.includes(sv);
              return (
                <button key={sv} className={`chip${on ? " on" : ""}`} aria-pressed={on} onClick={() => setServices(on ? services.filter((x) => x !== sv) : [...services, sv])}>
                  {sv}
                </button>
              );
            })}
          </div>
        )}
        <label className="check small">
          <input type="checkbox" checked={showLibrary} onChange={(e) => setShowLibrary(e.target.checked)} /> In my library
        </label>
        <label className="check small">
          <input type="checkbox" checked={showFiltered} onChange={(e) => setShowFiltered(e.target.checked)} /> Filtered & hidden
        </label>
        <button
          className="ghost small"
          disabled={!picks}
          onClick={() => {
            refresh.current = true;
            setReload((x) => x + 1);
          }}
        >
          Refresh
        </button>
      </div>

      {error && (
        <p className="error" role="alert">
          {error}{" "}
          <button className="ghost small" onClick={() => setReload((x) => x + 1)}>
            Retry
          </button>
        </p>
      )}
      {!picks && !error && <Spinner label="Scoring this season against your taste… the first run downloads a few seasons from AniList and can take a minute." />}
      {picks && !picks.length && <p className="muted">AniList hasn't announced anything for this season yet.</p>}
      {picks && picks.length > 0 && !visible.length && (
        <p className="muted">
          Everything is hidden by your filters ({hidden}).{" "}
          <button
            className="ghost small"
            onClick={() => {
              setDay(null);
              setServices([]);
              setShowFiltered(true);
              setShowLibrary(true);
            }}
          >
            Clear filters
          </button>
        </p>
      )}

      {picks && view === "grid" &&
        SECTIONS.map((sec) => {
          const items = visible.filter((p) => p.section === sec.id);
          if (!items.length) return null;
          const open = !collapsed.includes(sec.id);
          return (
            <div key={sec.id} className="section">
              <button className="section-head" aria-expanded={open} onClick={() => setCollapsed(open ? [...collapsed, sec.id] : collapsed.filter((x) => x !== sec.id))}>
                <span className="caret" aria-hidden="true">
                  {open ? "▾" : "▸"}
                </span>
                <h2>{sec.label}</h2>
                <span className="count">{items.length}</span>
                <span className="muted small hint">{sec.hint}</span>
              </button>
              {open && (
                <div className="grid">
                  {items.map((p) => (
                    <PickCard key={p.id} p={p} patch={patch} toast={toast} sonarr={!!status.sonarr} />
                  ))}
                </div>
              )}
            </div>
          );
        })}

      {picks && view === "schedule" && <Schedule picks={visible} all={picks} day={day} patch={patch} toast={toast} sonarr={!!status.sonarr} />}
    </section>
  );
}

// ---------------------------------------------------------------- schedule

function Schedule({ picks, all, day, patch, toast, sonarr }: { picks: Pick[]; all: Pick[]; day: number | null; patch: (id: number, c: Partial<Pick>) => void; toast: (m: string, e?: boolean) => void; sonarr: boolean }) {
  const airing = all.filter((p) => p.nextAiring);
  const followedPerDay = DAYS.map((_, i) => airing.filter((p) => weekday(p.nextAiring!.at) === i && (p.inLibrary || p.following) && p.verdict !== "disliked").length);
  const avg = followedPerDay.reduce((a, b) => a + b, 0) / 7;
  const days = day === null ? DAYS.map((_, i) => i) : [day];
  const [expanded, setExpanded] = useState<number[]>([]);

  return (
    <div className="schedule">
      <p className="muted small">
        Air times are in your time zone. "Light day" means you follow fewer shows that day than usual, so the best picks airing then are listed to fill it.
      </p>
      {days.map((i) => {
        const today = airing.filter((p) => weekday(p.nextAiring!.at) === i).sort((a, b) => (new Date(a.nextAiring!.at).getHours() * 60 + new Date(a.nextAiring!.at).getMinutes()) - (new Date(b.nextAiring!.at).getHours() * 60 + new Date(b.nextAiring!.at).getMinutes()));
        const followed = today.filter((p) => (p.inLibrary || p.following) && p.verdict !== "disliked");
        const ids = new Set(picks.map((p) => p.id));
        const suggestions = today.filter((p) => !p.inLibrary && !p.following && !p.excluded && ids.has(p.id)).sort((a, b) => b.score - a.score);
        const light = followed.length < Math.max(2, avg * 0.6);
        const more = expanded.includes(i);
        return (
          <div key={i} className={`day card pad${light ? " light" : ""}`}>
            <div className="card-head">
              <h2>{["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][i]}</h2>
              <span className="muted small">
                You follow {followed.length} {light && <span className="pill warn">Light day</span>}
              </span>
            </div>
            {followed.length > 0 && (
              <ul className="sched-list">
                {followed.map((p) => (
                  <SchedRow key={p.id} p={p} />
                ))}
              </ul>
            )}
            {suggestions.length > 0 && (
              <>
                <h3 className="small muted">{light ? "Fill it with" : "Also airing"}</h3>
                <div className="grid compact">
                  {suggestions.slice(0, more ? 50 : light ? 4 : 2).map((p) => (
                    <PickCard key={p.id} p={p} patch={patch} toast={toast} sonarr={sonarr} compact />
                  ))}
                </div>
                {suggestions.length > (light ? 4 : 2) && (
                  <button className="ghost small" onClick={() => setExpanded(more ? expanded.filter((x) => x !== i) : [...expanded, i])}>
                    {more ? "Show fewer" : `Show all ${suggestions.length}`}
                  </button>
                )}
              </>
            )}
            {!today.length && <p className="muted small">Nothing airing.</p>}
          </div>
        );
      })}
    </div>
  );
}

function SchedRow({ p }: { p: Pick }) {
  const d = new Date(p.nextAiring!.at);
  return (
    <li>
      <span className="time">{d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</span>
      <a href={p.siteUrl} target="_blank" rel="noreferrer">
        {p.title}
      </a>
      <span className="muted small">ep {p.nextAiring!.episode}</span>
      {p.streaming.slice(0, 2).map((s) => (
        <a key={s.site} className="chip link" href={s.url} target="_blank" rel="noreferrer">
          {s.site}
        </a>
      ))}
    </li>
  );
}

// ---------------------------------------------------------------- card

function PickCard({ p, patch, toast, sonarr, compact }: { p: Pick; patch: (id: number, c: Partial<Pick>) => void; toast: (m: string, e?: boolean) => void; sonarr: boolean; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [why, setWhy] = useState(false);
  const [more, setMore] = useState(false);

  async function act(what: "add" | "monitor" | "follow" | "unfollow") {
    setBusy(true);
    try {
      const r = await api<{ title?: string; monitoredSeason?: number | null; waitingForSeason?: boolean; season?: number }>(`/picks/${p.id}/${what}`, { body: {} });
      if (what === "follow" || what === "unfollow") {
        patch(p.id, { following: what === "follow", verdict: what === "follow" ? "added" : p.verdict });
        toast(what === "follow" ? `Following ${p.title}. You'll get an alert when episodes air.` : `Stopped following ${p.title}`);
      } else {
        patch(p.id, { inLibrary: true, seasonMonitored: true, verdict: "added" });
        const s = r.monitoredSeason ?? r.season;
        toast(
          `${p.title} ${what === "add" ? `added to ${p.addVia === "radarr" ? "Radarr" : "Sonarr"}` : "season monitored"}${s ? ` (season ${s} only)` : ""}${r.waitingForSeason ? ". TVDB hasn't listed it yet; Sonarr will pick it up when it does." : ""}`,
        );
      }
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }

  async function rate(verdict: "liked" | "disliked" | "hidden") {
    const prev = p.verdict;
    const next = prev === verdict ? null : verdict;
    patch(p.id, { verdict: next, excluded: next === "disliked" ? "You marked this 👎" : next === "hidden" ? "Hidden" : prev === "disliked" || prev === "hidden" ? null : p.excluded });
    try {
      await api("/feedback", { body: { id: p.id, verdict: next } });
    } catch (e) {
      patch(p.id, { verdict: prev, excluded: p.excluded });
      toast((e as Error).message, true);
    }
  }

  const meta = [p.format?.replace("_", " "), p.episodes && `${p.episodes} eps`, p.studio, p.source].filter(Boolean).join(" · ");
  const when = p.nextAiring ? `Ep ${p.nextAiring.episode} · ${airLabel(p.nextAiring.at)}` : p.status === "NOT_YET_RELEASED" ? (p.startDate ? `Starts ${p.startDate}` : "Not yet aired") : p.status === "FINISHED" ? "Finished" : null;

  let primary: React.ReactNode;
  if (p.inLibrary) {
    primary =
      p.seasonMonitored === false && p.tvdbSeason ? (
        <button className="primary" disabled={busy} onClick={() => act("monitor")}>
          Monitor S{p.tvdbSeason}
        </button>
      ) : (
        <span className="badge">In library</span>
      );
  } else if (p.addVia) {
    primary = (
      <button className="primary" disabled={busy} onClick={() => act("add")}>
        {busy ? "Adding…" : `Add to ${p.addVia === "radarr" ? "Radarr" : "Sonarr"}`}
      </button>
    );
  } else if (p.section !== "movies") {
    primary = (
      <button className={p.following ? "ghost" : "primary"} disabled={busy} onClick={() => act(p.following ? "unfollow" : "follow")} title={p.cantAdd ?? undefined}>
        {p.following ? "Following ✓" : "Follow"}
      </button>
    );
  } else primary = <span className="badge muted">{p.cantAdd}</span>;

  return (
    <article className={`pick card${p.excluded ? " dim" : ""}${compact ? " compact" : ""}`} style={{ "--accent": p.color ?? "#8b5cf6" } as React.CSSProperties}>
      <a className="cover" href={p.siteUrl} target="_blank" rel="noreferrer">
        {p.cover ? <img src={p.cover} alt={p.title} loading="lazy" /> : <div className="noimg" />}
        {p.carryOver && <span className="tag">Carry-over</span>}
      </a>
      <div className="body">
        <h3 title={p.altTitle ?? undefined}>{p.title}</h3>
        <p className="meta">{meta}</p>
        {when && <p className="meta airing">{when}</p>}
        <div className="match">
          <div className="bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={p.match} aria-label="Match">
            <div style={{ width: `${p.match}%` }} />
          </div>
          <button className="linklike small" aria-expanded={why} onClick={() => setWhy(!why)}>
            {p.match}% match{p.lowConfidence ? "?" : ""}
          </button>
          {p.averageScore && <span className="small muted" title="AniList average score">★ {p.averageScore}</span>}
        </div>
        {p.continues && <p className="similar">{p.continues.watched ? "Continues" : "Sequel to"} {p.continues.title}</p>}
        {!p.continues && p.similar && <p className="similar">Like {p.similar}</p>}
        {why && (
          <div className="why small">
            {p.reasons.map((r) => (
              <div key={r.label} className="good">
                + {r.label}: you keep these {r.lift}× as often as average
              </div>
            ))}
            {p.warnings.map((r) => (
              <div key={r.label} className="bad">
                − {r.label}: you keep these {r.lift}× as often
              </div>
            ))}
            {p.lowConfidence && <div className="muted">Not much is known about this show yet, so the score is a rough guess.</div>}
          </div>
        )}
        {!compact && (
          <div className="chips">
            {p.reasons.map((r) => (
              <span key={r.label} className="chip good">
                {r.label}
              </span>
            ))}
            {p.warnings.map((r) => (
              <span key={r.label} className="chip bad">
                {r.label}
              </span>
            ))}
          </div>
        )}
        {p.streaming.length > 0 && (
          <div className="chips">
            {p.streaming.slice(0, compact ? 2 : 5).map((s) => (
              <a key={s.site + s.url} className="chip link" href={s.url} target="_blank" rel="noreferrer">
                ▶ {s.site}
              </a>
            ))}
          </div>
        )}
        {!compact && (p.description || p.trailer) && (
          <div className="small">
            {p.description && (
              <button className="linklike small" aria-expanded={more} onClick={() => setMore(!more)}>
                {more ? "Less" : "Synopsis"}
              </button>
            )}
            {p.trailer && (
              <>
                {" · "}
                <a href={p.trailer} target="_blank" rel="noreferrer">
                  Trailer
                </a>
              </>
            )}
            {more && <p className="synopsis">{p.description}</p>}
          </div>
        )}
        {p.excluded && <p className="excluded">Filtered: {p.excluded}</p>}
        <div className="actions">
          <div className="primary-action">{primary}</div>
          <div className="rate">
            <button className={`icon${p.verdict === "liked" ? " on" : ""}`} aria-label={`Looks good: ${p.title}`} aria-pressed={p.verdict === "liked"} onClick={() => rate("liked")}>
              👍
            </button>
            <button className={`icon${p.verdict === "disliked" ? " on" : ""}`} aria-label={`Not for me: ${p.title}`} aria-pressed={p.verdict === "disliked"} onClick={() => rate("disliked")}>
              👎
            </button>
            <button className={`icon${p.verdict === "hidden" ? " on" : ""}`} aria-label={`Hide ${p.title}`} aria-pressed={p.verdict === "hidden"} onClick={() => rate("hidden")}>
              ✕
            </button>
          </div>
        </div>
      </div>
    </article>
  );
}
