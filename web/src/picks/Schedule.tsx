import { useState } from "react";
import type { Pick } from "../api";
import { PickCard } from "./PickCard";
import { DAYS, DAY_NAMES, todayIdx, weekday } from "./helpers";
import type { CardProps } from "./types";

export function Schedule({
  picks,
  all,
  day,
  isCurrent,
  ...card
}: CardProps & { picks: Pick[]; all: Pick[]; day: number | null; isCurrent: boolean }) {
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
        {total >= 5 ? ' A "quiet day" is one where you follow fewer shows than usual, so a few good picks airing then are suggested.' : ""}
      </p>
      {days.map((i) => {
        const today = airing.filter((p) => weekday(p.nextAiring!.at) === i).sort((a, b) => minutes(a) - minutes(b));
        const followed = today.filter(mine);
        const suggestions = today
          .filter((p) => !mine(p) && !p.excluded && !p.inLibrary && p.section !== "shorts" && ids.has(p.id) && p.match >= 25)
          .sort((a, b) => b.match - a.match);
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
                {followed.length ? `${followed.length} you follow` : "Nothing you follow"}{" "}
                {quiet && <span className="pill warn">Quiet day</span>}
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

export function SchedRow({ p }: { p: Pick }) {
  const d = new Date(p.nextAiring!.at);
  return (
    <li>
      <span className="time">{d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</span>
      <a href={p.siteUrl} target="_blank" rel="noreferrer">
        {p.title}
      </a>
      <span className="muted small">
        ep {p.nextAiring!.episode}
        {p.nextAiring!.at - Date.now() > 6 * 86_400_000 ? " (next week; this week's is out)" : ""}
      </span>
      {p.streaming.slice(0, 2).map((s) => (
        <a key={s.site} className="chip link" href={s.url} target="_blank" rel="noreferrer">
          ▶ {s.site}
        </a>
      ))}
    </li>
  );
}
