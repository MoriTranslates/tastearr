import { useCallback, useEffect, useMemo, useState } from "react";
import { api, seasonName, shiftSeason, store, type AddPlan, type Candidate, type Pick, type Season, type Section, type Status } from "../api";
import { airLabel, dateLabel, ErrorBox, Modal, Spinner, usePageTitle, useToast } from "../ui";

const SECTIONS: { id: Section; label: string; hint: string }[] = [
  { id: "continuing", label: "Continuing", hint: "New seasons of shows you know, and shows still airing" },
  { id: "new", label: "New shows", hint: "Brand-new series this season" },
  { id: "shorts", label: "Shorts", hint: "Short episodes (15 minutes or less)" },
  { id: "movies", label: "Movies", hint: "Films and theatrical releases" },
];
const SORTS = {
  match: { label: "Best match", fn: (a: Pick, b: Pick) => b.match - a.match || b.score - a.score },
  popularity: { label: "Most popular", fn: (a: Pick, b: Pick) => b.popularity - a.popularity },
  rating: { label: "Highest rated", fn: (a: Pick, b: Pick) => (b.averageScore ?? 0) - (a.averageScore ?? 0) },
  airing: { label: "Airing soonest", fn: (a: Pick, b: Pick) => (a.nextAiring?.at ?? Infinity) - (b.nextAiring?.at ?? Infinity) },
  title: { label: "A–Z", fn: (a: Pick, b: Pick) => a.title.localeCompare(b.title) },
} as const;
type SortKey = keyof typeof SORTS;
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
/** Monday = 0, in the viewer's local time. */
const weekday = (ms: number) => (new Date(ms).getDay() + 6) % 7;
const todayIdx = () => weekday(Date.now());
const isMobile = () => typeof window !== "undefined" && window.matchMedia("(max-width: 720px)").matches;

/** Picks per season, kept while the tab is open so switching pages doesn't refetch and blank the screen. */
const cache = new Map<string, Pick[]>();

function readQuery(status: Status) {
  const q = new URLSearchParams(location.search);
  const season = q.get("season")?.toUpperCase() as Season | undefined;
  const year = Number(q.get("year"));
  return {
    sel: season && year ? { season, year } : status.season!,
    view: ((q.get("view") ?? store.get("view", "grid")) === "schedule" ? "schedule" : "grid") as "grid" | "schedule",
    day: q.get("day") !== null && q.get("day") !== "" ? Number(q.get("day")) : null,
  };
}

export function Picks({ status }: { status: Status }) {
  const hideInLibrary = status.prefs?.hideInLibrary ?? false;
  const hideShorts = status.prefs?.hideShorts ?? false;
  const init = useMemo(() => readQuery(status), [status]);
  const toast = useToast();
  const [sel, setSel] = useState(init.sel);
  const [view, setView] = useState(init.view);
  const [day, setDay] = useState<number | null>(init.day);
  const [sort, setSort] = useState<SortKey>(() => store.get("sort", "match"));
  const [services, setServices] = useState<string[]>(() => store.get("services", []));
  const [showLibrary, setShowLibrary] = useState(() => store.get("showLibrary", !hideInLibrary));
  const [showFiltered, setShowFiltered] = useState(false);
  const [collapsed, setCollapsed] = useState<Section[]>(() => store.get("collapsed", hideShorts ? (["shorts"] as Section[]) : []));
  const [filtersOpen, setFiltersOpen] = useState(() => !isMobile());
  const key = `${sel.season}-${sel.year}`;
  const [picks, setPicks] = useState<Pick[] | null>(() => cache.get(key) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [refresh, setRefresh] = useState(false);
  const [adding, setAdding] = useState<Pick | null>(null);
  usePageTitle(`${seasonName(sel.season)} ${sel.year}`);

  useEffect(() => {
    const q = new URLSearchParams({ season: sel.season, year: String(sel.year) });
    if (view === "schedule") q.set("view", "schedule");
    if (day !== null) q.set("day", String(day));
    history.replaceState(null, "", `/?${q}`);
    store.set("view", view);
  }, [sel, view, day]);
  useEffect(() => store.set("sort", sort), [sort]);
  useEffect(() => store.set("services", services), [services]);
  useEffect(() => store.set("showLibrary", showLibrary), [showLibrary]);
  useEffect(() => store.set("collapsed", collapsed), [collapsed]);

  useEffect(() => {
    const ctrl = new AbortController();
    const cached = cache.get(key);
    setPicks(cached ?? null);
    setError(null);
    api<{ picks: Pick[] }>(`/picks?season=${sel.season}&year=${sel.year}${refresh ? "&refresh=1" : ""}`, { signal: ctrl.signal })
      .then((x) => {
        cache.set(key, x.picks);
        setPicks(x.picks);
        setRefresh(false);
      })
      .catch((e) => {
        if (!ctrl.signal.aborted && !cached) setError((e as Error).message);
      });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, reload]);

  const patch = useCallback(
    (id: number, change: Partial<Pick>) =>
      setPicks((list) => {
        const next = list?.map((p) => (p.id === id ? { ...p, ...change } : p)) ?? null;
        if (next) cache.set(key, next);
        return next;
      }),
    [key],
  );

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
  const top = useMemo(
    () => (picks ?? []).filter((p) => !p.excluded && !p.inLibrary && !p.myStatus && !p.following && p.section !== "shorts").sort((a, b) => b.match - a.match)[0] ?? null,
    [picks],
  );
  const filterCount = (day !== null ? 1 : 0) + services.length + (showLibrary ? 0 : 1) + (showFiltered ? 1 : 0);
  const isCurrent = sel.season === status.season?.season && sel.year === status.season?.year;

  return (
    <section>
      <div className="toolbar">
        <div className="season-nav">
          <button onClick={() => setSel(shiftSeason(sel, -1))} aria-label="Previous season" title="Previous season">
            ‹
          </button>
          <h1>
            {seasonName(sel.season)} {sel.year}
          </h1>
          <button onClick={() => setSel(shiftSeason(sel, 1))} aria-label="Next season" title="Next season">
            ›
          </button>
        </div>
        <div className="row">
          {isCurrent && (
            <button
              className={view === "schedule" && day === todayIdx() ? "primary" : ""}
              onClick={() => {
                setView("schedule");
                setDay(todayIdx());
              }}
            >
              Tonight
            </button>
          )}
          <div className="seg" role="radiogroup" aria-label="View">
            {(["grid", "schedule"] as const).map((v) => (
              <button key={v} role="radio" aria-checked={view === v} className={view === v ? "on" : ""} onClick={() => setView(v)}>
                {v === "grid" ? "Picks" : "Schedule"}
              </button>
            ))}
          </div>
          <button className="ghost" aria-expanded={filtersOpen} onClick={() => setFiltersOpen(!filtersOpen)}>
            Filters{filterCount ? ` (${filterCount})` : ""}
          </button>
        </div>
      </div>

      {filtersOpen && (
        <div className="filters card pad">
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
          <div className="chips scroll" role="group" aria-label="Air day">
            {DAYS.map((d, i) => (
              <button key={d} className={`chip${day === i ? " on" : ""}`} aria-pressed={day === i} onClick={() => setDay(day === i ? null : i)}>
                {i === todayIdx() && isCurrent ? "Today" : d}
              </button>
            ))}
          </div>
          {allServices.length > 0 && (
            <div className="chips scroll" role="group" aria-label="Where it streams">
              {allServices.map((sv) => {
                const on = services.includes(sv);
                return (
                  <button key={sv} className={`chip${on ? " on" : ""}`} aria-pressed={on} onClick={() => setServices(on ? services.filter((x) => x !== sv) : [...services, sv])}>
                    {on ? "✓ " : ""}
                    {sv}
                  </button>
                );
              })}
            </div>
          )}
          <label className="check small">
            <input type="checkbox" checked={showLibrary} onChange={(e) => setShowLibrary(e.target.checked)} /> Show ones I already have
          </label>
          <label className="check small">
            <input type="checkbox" checked={showFiltered} onChange={(e) => setShowFiltered(e.target.checked)} /> Show hidden ones
          </label>
          <button
            className="ghost small"
            disabled={!picks}
            onClick={() => {
              setRefresh(true);
              setReload((x) => x + 1);
            }}
          >
            Refresh from AniList
          </button>
        </div>
      )}

      {error && !picks && <ErrorBox error={error} retry={() => setReload((x) => x + 1)} />}
      {!picks && !error && <Spinner label="Ranking this season for you… the first time can take a minute while Tastearr downloads the season from AniList." />}
      {picks && !picks.length && <p className="muted">AniList hasn't announced anything for this season yet.</p>}
      {picks && picks.length > 0 && !visible.length && (
        <p className="muted">
          Your filters hide everything ({hidden}).{" "}
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

      {picks && view === "grid" && top && day === null && !services.length && (
        <div className="hero">
          <h2 className="small muted">Top pick for you</h2>
          <PickCard p={top} patch={patch} toast={toast} status={status} onAdd={setAdding} />
        </div>
      )}

      {picks && view === "grid" &&
        SECTIONS.map((sec) => {
          const items = visible.filter((p) => p.section === sec.id);
          if (!items.length) return null;
          const open = !collapsed.includes(sec.id);
          return (
            <div key={sec.id} className="section">
              <h2 className="section-head">
                <button aria-expanded={open} onClick={() => setCollapsed(open ? [...collapsed, sec.id] : collapsed.filter((x) => x !== sec.id))}>
                  <span className="caret" aria-hidden="true">
                    {open ? "▾" : "▸"}
                  </span>
                  {sec.label}
                  <span className="count">{items.length}</span>
                </button>
                <span className="muted small hint">{sec.hint}</span>
              </h2>
              {open && (
                <div className="grid">
                  {items.map((p) => (
                    <PickCard key={p.id} p={p} patch={patch} toast={toast} status={status} onAdd={setAdding} />
                  ))}
                </div>
              )}
            </div>
          );
        })}

      {picks && view === "schedule" && <Schedule picks={visible} all={picks} day={day} patch={patch} toast={toast} status={status} onAdd={setAdding} isCurrent={isCurrent} />}
      {adding && <AddDialog p={adding} onClose={() => setAdding(null)} patch={patch} toast={toast} />}
    </section>
  );
}

// ---------------------------------------------------------------- schedule

type CardProps = { patch: (id: number, c: Partial<Pick>) => void; toast: ReturnType<typeof useToast>; status: Status; onAdd: (p: Pick) => void };

function Schedule({ picks, all, day, isCurrent, ...card }: CardProps & { picks: Pick[]; all: Pick[]; day: number | null; isCurrent: boolean }) {
  const airing = all.filter((p) => p.nextAiring);
  const mine = (p: Pick) => (p.inLibrary || p.following || p.myStatus === "watching") && p.verdict !== "disliked" && !p.excluded;
  const perDay = DAYS.map((_, i) => airing.filter((p) => weekday(p.nextAiring!.at) === i && mine(p)).length);
  const total = perDay.reduce((a, b) => a + b, 0);
  const avg = total / 7;
  const days = day === null ? DAYS.map((_, i) => i) : [day];
  const [expanded, setExpanded] = useState<number[]>([]);
  const ids = new Set(picks.map((p) => p.id));
  const minutes = (p: Pick) => {
    const d = new Date(p.nextAiring!.at);
    return d.getHours() * 60 + d.getMinutes();
  };

  return (
    <div className="schedule">
      <p className="muted small">
        Times are when each episode airs in Japan, shown in your time zone. Streaming services usually post it within a few hours.
        {total >= 5 ? " A \"quiet day\" is one where you follow fewer shows than usual, so a few good picks airing then are suggested." : ""}
      </p>
      {days.map((i) => {
        const today = airing.filter((p) => weekday(p.nextAiring!.at) === i).sort((a, b) => minutes(a) - minutes(b));
        const followed = today.filter(mine);
        const suggestions = today.filter((p) => !mine(p) && !p.excluded && !p.inLibrary && p.section !== "shorts" && ids.has(p.id) && p.match >= 25).sort((a, b) => b.match - a.match);
        const quiet = total >= 5 && followed.length < Math.max(2, avg * 0.6);
        const shown = expanded.includes(i) ? 50 : quiet ? 3 : 2;
        return (
          <div key={i} className={`day card pad${quiet ? " light" : ""}`}>
            <div className="card-head">
              <h2>
                {DAY_NAMES[i]}
                {isCurrent && i === todayIdx() ? " (today)" : ""}
              </h2>
              <span className="muted small">
                {followed.length ? `${followed.length} you follow` : "Nothing you follow"} {quiet && <span className="pill warn">Quiet day</span>}
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
                <h3 className="small muted">{quiet ? "Something to fill it" : "Also airing"}</h3>
                <div className="grid compact">
                  {suggestions.slice(0, shown).map((p) => (
                    <PickCard key={p.id} p={p} {...card} compact />
                  ))}
                </div>
                {suggestions.length > shown && (
                  <button className="ghost small" onClick={() => setExpanded([...expanded, i])}>
                    Show all {suggestions.length}
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
          ▶ {s.site}
        </a>
      ))}
    </li>
  );
}

// ---------------------------------------------------------------- card

const STATUS_BADGE: Record<string, string> = { watching: "You're watching", seen: "You've seen it", planning: "On your list", following: "Following", dropped: "You stopped this" };

function matchText(p: Pick) {
  if (p.match < 15) return "Not for you";
  return p.lowConfidence ? `~${p.match}% match` : `${p.match}% match`;
}

function storyLine(p: Pick) {
  if (p.continues) {
    if (p.continues.behind > 0) return `Sequel to ${p.continues.title}. You're ${p.continues.behind} season${p.continues.behind > 1 ? "s" : ""} behind.`;
    return p.continues.kept ? `Continues ${p.continues.title}` : `Sequel to ${p.continues.title}`;
  }
  if (p.spinOffOf) return `Spin-off of ${p.spinOffOf}`;
  if (p.similar) return `Similar to ${p.similar}`;
  return null;
}

function PickCard({ p, patch, toast, status, onAdd, compact }: CardProps & { p: Pick; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [why, setWhy] = useState(false);
  const [more, setMore] = useState(false);

  async function follow(on: boolean) {
    setBusy(true);
    try {
      await api(`/picks/${p.id}/${on ? "follow" : "unfollow"}`, { body: {} });
      patch(p.id, { following: on, verdict: on ? "added" : p.verdict });
      toast(
        on
          ? status.alerts
            ? `Following ${p.title}. You'll get an alert when episodes come out.`
            : `Following ${p.title}. It's on your Schedule and in My Shows. Set up alerts in Settings to get a ping when episodes come out.`
          : `Stopped following ${p.title}`,
      );
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }

  async function monitor() {
    if (!confirm(`Turn on season ${p.tvdbSeason} of ${p.title} in Sonarr and search for it?`)) return;
    setBusy(true);
    try {
      const r = await api<{ waitingForSeason?: boolean; resumedSeries?: boolean }>(`/picks/${p.id}/monitor`, { body: {} });
      patch(p.id, { seasonMonitored: true, verdict: "added" });
      toast(`Season ${p.tvdbSeason} turned on in Sonarr${r.resumedSeries ? " (the series was switched back on too)" : ""}${r.waitingForSeason ? ". TVDB hasn't listed it yet; Sonarr will grab it when it does." : ""}`);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }

  async function rate(verdict: "liked" | "disliked" | "hidden") {
    const prev = { verdict: p.verdict, excluded: p.excluded };
    const next = p.verdict === verdict ? null : verdict;
    const excluded = next === "disliked" ? "You marked this 👎" : next === "hidden" ? "You hid this" : prev.verdict === "disliked" || prev.verdict === "hidden" ? null : p.excluded;
    patch(p.id, { verdict: next, excluded });
    try {
      await api("/feedback", { body: { id: p.id, verdict: next } });
      if (next === "disliked" || next === "hidden") {
        toast(`${next === "hidden" ? "Hidden" : "Got it, less like this"}: ${p.title}`, false, {
          label: "Undo",
          run: () => {
            patch(p.id, prev);
            void api("/feedback", { body: { id: p.id, verdict: prev.verdict } }).catch((e) => toast((e as Error).message, true));
          },
        });
      }
    } catch (e) {
      patch(p.id, prev);
      toast((e as Error).message, true);
    }
  }

  const meta = [p.format === "TV_SHORT" ? "Short" : p.format === "ONA" ? "Web" : p.format === "MOVIE" ? "Movie" : "TV", p.episodes && `${p.episodes} eps`, p.duration && p.duration <= 15 ? `${p.duration} min` : null, p.studio, p.source].filter(Boolean).join(" · ");
  const when =
    p.format === "MOVIE"
      ? p.startDate
        ? `${p.status === "FINISHED" ? "Released" : "Out"} ${dateLabel(p.startDate)}`
        : "Release date not announced"
      : p.nextAiring
        ? `Ep ${p.nextAiring.episode} · ${airLabel(p.nextAiring.at)}`
        : p.status === "NOT_YET_RELEASED"
          ? p.startDate
            ? `Starts ${dateLabel(p.startDate)}`
            : "Start date not announced"
          : p.status === "FINISHED"
            ? "Finished airing"
            : null;
  const story = storyLine(p);

  let primary: React.ReactNode;
  if (p.inLibrary) {
    primary =
      p.seasonMonitored === false && p.tvdbSeason ? (
        <button className="primary" disabled={busy} onClick={monitor}>
          Get season {p.tvdbSeason}
        </button>
      ) : (
        <span className="badge">✓ You have this</span>
      );
  } else if (p.addVia || p.needsMatch) {
    primary = (
      <button className="primary" disabled={busy} onClick={() => onAdd(p)}>
        Add to {p.addVia === "radarr" ? "Radarr" : "Sonarr"}…
      </button>
    );
  } else if (p.section !== "movies") {
    primary = (
      <button className={p.following ? "ghost" : "primary"} disabled={busy} onClick={() => follow(!p.following)}>
        {p.following ? "✓ Following" : "Follow"}
      </button>
    );
  } else primary = p.cantAdd ? <span className="badge muted">{p.cantAdd}</span> : null;

  return (
    <article className={`pick card${p.excluded ? " dim" : ""}${compact ? " compact" : ""}`} style={{ "--cover": p.color ?? "#7c3aed" } as React.CSSProperties}>
      <a className="cover" href={p.siteUrl} target="_blank" rel="noreferrer" title="Open on AniList (new tab)">
        {p.cover ? <img src={p.cover} alt={p.title} loading="lazy" /> : <div className="noimg" />}
        {p.carryOver && <span className="tag">Still airing</span>}
      </a>
      <div className="body">
        <h3 title={p.altTitle ? `${p.title} / ${p.altTitle}` : p.title}>{p.title}</h3>
        <p className="meta">{meta}</p>
        {when && <p className="meta airing">{when}</p>}
        {p.myStatus && <span className="badge status">{STATUS_BADGE[p.myStatus]}</span>}
        <div className="match">
          <div className="bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={p.match} aria-label="Match">
            <div style={{ width: `${p.match}%` }} />
          </div>
          <button className="linklike small" aria-expanded={why} onClick={() => setWhy(!why)} title="Why this score?">
            {matchText(p)} ⓘ
          </button>
          {p.averageScore ? (
            <span className="small muted" title="Average score on AniList">
              ★ {p.averageScore}
            </span>
          ) : null}
        </div>
        {story && <p className="similar">{story}</p>}
        {why && (
          <div className="why small">
            {p.continues?.kept && <div className="good">✓ You kept the previous season</div>}
            {p.reasons.map((r) => (
              <div key={r.label} className="good">
                ✓ You tend to like {r.label.toLowerCase()} ({r.lift}× your average)
              </div>
            ))}
            {p.warnings.map((r) => (
              <div key={r.label} className="bad">
                ✗ You usually skip {r.label.toLowerCase()}
              </div>
            ))}
            {p.lowConfidence && <div className="muted">There isn't much information about this show yet, so this is a rough guess.</div>}
            {!p.reasons.length && !p.warnings.length && !p.continues && <div className="muted">Mostly based on how popular it is this season.</div>}
          </div>
        )}
        {!compact && (p.reasons.length > 0 || p.warnings.length > 0) && (
          <div className="chips">
            {p.reasons.map((r) => (
              <span key={r.label} className="chip good">
                ✓ {r.label}
              </span>
            ))}
            {p.warnings.map((r) => (
              <span key={r.label} className="chip bad">
                ✗ {r.label}
              </span>
            ))}
          </div>
        )}
        {p.streaming.length > 0 && (
          <div className="chips">
            {p.streaming.slice(0, compact ? 2 : 5).map((s) => (
              <a key={s.site} className="chip link" href={s.url} target="_blank" rel="noreferrer" title={`Watch on ${s.site} (new tab)`}>
                ▶ {s.site}
              </a>
            ))}
          </div>
        )}
        {!compact && (p.description || p.trailer) && (
          <div className="small">
            {p.description && (
              <button className="linklike small" aria-expanded={more} onClick={() => setMore(!more)}>
                {more ? "Hide story" : "Story"}
              </button>
            )}
            {p.trailer && (
              <>
                {p.description ? " · " : ""}
                <a href={p.trailer} target="_blank" rel="noreferrer">
                  Trailer
                </a>
              </>
            )}
            {more && (
              <>
                <p className="synopsis">{p.description}</p>
                <button className="linklike small" onClick={() => setMore(false)}>
                  Hide story
                </button>
              </>
            )}
          </div>
        )}
        {p.excluded && <p className="excluded">Hidden: {p.excluded}</p>}
        <div className="actions">
          <div className="primary-action">{primary}</div>
          <div className="rate">
            <button className={`icon${p.verdict === "liked" ? " on" : ""}`} title="I'd like this" aria-label={`I'd like ${p.title}`} aria-pressed={p.verdict === "liked"} onClick={() => rate("liked")}>
              👍
            </button>
            <button className={`icon${p.verdict === "disliked" ? " on" : ""}`} title="Not for me" aria-label={`Not for me: ${p.title}`} aria-pressed={p.verdict === "disliked"} onClick={() => rate("disliked")}>
              👎
            </button>
            <button className={`ghost small hide${p.verdict === "hidden" ? " on" : ""}`} title="Hide from my picks" aria-pressed={p.verdict === "hidden"} onClick={() => rate("hidden")}>
              Hide
            </button>
          </div>
        </div>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------- add dialog

function AddDialog({ p, onClose, patch, toast }: { p: Pick; onClose: () => void; patch: CardProps["patch"]; toast: CardProps["toast"] }) {
  const [plan, setPlan] = useState<AddPlan | null>(null);
  const [cands, setCands] = useState<Candidate[] | null>(null);
  const [match, setMatch] = useState<{ tvdbId: number; season: number | null } | null>(null);
  const [monitor, setMonitor] = useState<AddPlan["monitor"]>();
  const [search, setSearch] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<AddPlan>(`/picks/${p.id}/plan`)
      .then((x) => {
        setPlan(x);
        setMonitor(x.monitor);
        setSearch(x.search ?? true);
        if (x.needsMatch) api<Candidate[]>(`/picks/${p.id}/candidates`).then(setCands).catch((e) => setError(e.message));
      })
      .catch((e) => setError(e.message));
  }, [p.id]);

  async function add() {
    setBusy(true);
    try {
      const body = plan?.app === "sonarr" ? { monitor, search, ...(match ? { tvdbId: match.tvdbId, season: match.season } : {}) } : {};
      const r = await api<{ title: string; monitored?: string; waitingForSeason?: boolean }>(`/picks/${p.id}/add`, { body });
      patch(p.id, { inLibrary: true, seasonMonitored: true, verdict: "added", needsMatch: false });
      toast(`${r.title} added to ${plan?.app === "radarr" ? "Radarr" : "Sonarr"}${r.monitored ? ` (${r.monitored.toLowerCase()})` : ""}${r.waitingForSeason ? ". TVDB hasn't listed the new season yet; Sonarr will grab it when it does." : ""}`);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Add ${p.title}`} onClose={onClose}>
      {error && <p className="error">{error}</p>}
      {!plan && !error && <Spinner label="Checking with Sonarr…" />}
      {plan?.needsMatch && !match && (
        <>
          <p className="small">The anime database Tastearr uses hasn't matched this show to Sonarr yet. Pick the right one:</p>
          {!cands && !error && <Spinner label="Searching Sonarr…" />}
          {cands && !cands.length && <p className="muted small">Sonarr couldn't find it either. Try again in a few days.</p>}
          <div className="cand-list">
            {cands?.map((c) => (
              <button
                key={c.tvdbId}
                className="cand"
                onClick={() => {
                  // A manual match doesn't tell us which TVDB season this is, so default to "only new episodes".
                  setMatch({ tvdbId: c.tvdbId, season: null });
                  setMonitor(c.seasons.length > 1 ? "future" : "all");
                }}
              >
                <strong>{c.title}</strong> <span className="muted small">{[c.year, c.network, c.seasons.length ? `${c.seasons.length} season${c.seasons.length > 1 ? "s" : ""}` : null].filter(Boolean).join(" · ")}</span>
                {c.overview && <span className="muted small block">{c.overview}</span>}
              </button>
            ))}
          </div>
        </>
      )}
      {plan && (!plan.needsMatch || match) && (
        <div className="stack">
          {plan.app === "sonarr" && !plan.needsMatch && (
            <ul className="plan small">
              <li>
                <strong>{plan.title}</strong>
                {plan.year ? ` (${plan.year})` : ""} as an anime series
              </li>
              <li>Quality: {plan.profile ?? "not set"} · Folder: {plan.rootFolder}</li>
              <li>Tags: {plan.tags?.join(", ")}</li>
              {plan.resumesSeries && <li className="warn">This series is switched off in Sonarr; adding this season turns it back on.</li>}
            </ul>
          )}
          {plan.app === "sonarr" && (
            <>
              <label className="field">
                What to download
                <select value={monitor} onChange={(e) => setMonitor(e.target.value as AddPlan["monitor"])}>
                  {(match ? [{ value: "all", label: "All seasons" }, { value: "future", label: "Only new episodes from now on" }, { value: "none", label: "Nothing (add it unmonitored)" }] : (plan.options ?? [])).map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="check small">
                <input type="checkbox" checked={search} disabled={monitor === "none" || monitor === "future"} onChange={(e) => setSearch(e.target.checked)} /> Start searching right away
              </label>
            </>
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
            <button className="primary" disabled={busy} onClick={add}>
              {busy ? "Adding…" : "Add"}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
