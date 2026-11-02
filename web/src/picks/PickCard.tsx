import { useState } from "react";
import { api, type Pick } from "../api";
import { airLabel, dateLabel } from "../lib/format";
import { STATUS_BADGE, matchText, storyLine } from "./helpers";
import type { CardProps } from "./types";

export function PickCard({ p, patch, toast, status, onAdd, compact }: CardProps & { p: Pick; compact?: boolean }) {
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
          ? p.format === "MOVIE"
            ? `Following ${p.title}. It's in My Shows; where to stream it appears there once it's on a service.`
            : status.alerts
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

  async function rate(verdict: "liked" | "disliked" | "hidden") {
    const prev = { verdict: p.verdict, excluded: p.excluded };
    const next = p.verdict === verdict ? null : verdict;
    const excluded =
      next === "disliked"
        ? "You marked this 👎"
        : next === "hidden"
          ? "You hid this"
          : prev.verdict === "disliked" || prev.verdict === "hidden"
            ? null
            : p.excluded;
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

  const meta = [
    p.format === "TV_SHORT" && (!p.duration || p.duration <= 9)
      ? "Short"
      : p.format === "ONA"
        ? "Web"
        : p.format === "MOVIE"
          ? "Movie"
          : "TV",
    p.episodes && `${p.episodes} eps`,
    p.duration && p.duration <= 15 ? `${p.duration} min` : null,
    p.studio,
    p.source,
  ]
    .filter(Boolean)
    .join(" · ");
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
  if (p.inLibrary && p.matchGuessed && !p.tvdbSeason && p.status !== "FINISHED" && !p.seasonMonitored) {
    // A new season of a series in Sonarr whose TVDB season isn't known yet: let the user say which season it is.
    primary = (
      <button className="primary" disabled={busy} onClick={() => onAdd(p, "pick-season")}>
        Get the new season…
      </button>
    );
  } else if (p.inLibrary) {
    primary =
      p.seasonMonitored === false && p.tvdbSeason ? (
        <button className="primary" disabled={busy} onClick={() => onAdd(p, "monitor")}>
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
    <article
      className={`pick card${p.excluded ? " dim" : ""}${compact ? " compact" : ""}`}
      style={{ "--cover": p.color ?? "#7c3aed" } as React.CSSProperties}
    >
      <a className="cover" href={p.siteUrl} target="_blank" rel="noreferrer" title="Open on AniList (new tab)">
        {p.cover ? <img src={p.cover} alt={p.title} loading="lazy" /> : <div className="noimg" />}
        {p.carryOver && <span className="tag">Still airing</span>}
      </a>
      <div className="body">
        <h3 title={p.altTitle ? `${p.title} / ${p.altTitle}` : p.title}>{p.title}</h3>
        <p className="meta">{meta}</p>
        {when && <p className="meta airing">{when}</p>}
        {p.myStatus && <span className="badge status">{STATUS_BADGE[p.myStatus]}</span>}
        {p.matchGuessed && p.inLibrary && (
          <span
            className="badge muted"
            title="The anime database hasn't matched this season yet; Tastearr used the earlier season's Sonarr entry"
          >
            Matched by earlier season
          </span>
        )}
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
            {!p.reasons.length && !p.warnings.length && !p.continues && (
              <div className="muted">Mostly based on how popular it is this season.</div>
            )}
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
            <button
              className={`icon${p.verdict === "liked" ? " on" : ""}`}
              title="I'd like this"
              aria-label={`I'd like ${p.title}`}
              aria-pressed={p.verdict === "liked"}
              onClick={() => rate("liked")}
            >
              👍
            </button>
            <button
              className={`icon${p.verdict === "disliked" ? " on" : ""}`}
              title="Not for me"
              aria-label={`Not for me: ${p.title}`}
              aria-pressed={p.verdict === "disliked"}
              onClick={() => rate("disliked")}
            >
              👎
            </button>
            <button
              className={`ghost small hide${p.verdict === "hidden" ? " on" : ""}`}
              title="Hide from my picks"
              aria-label={`Hide ${p.title}`}
              aria-pressed={p.verdict === "hidden"}
              onClick={() => rate("hidden")}
            >
              Hide
            </button>
          </div>
        </div>
      </div>
    </article>
  );
}
