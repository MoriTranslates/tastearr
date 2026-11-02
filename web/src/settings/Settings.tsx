import { useState } from "react";
import { api, store, type Settings as S, type Status } from "../api";
import { Link } from "../router";
import { AlertsCard } from "./AlertsCard";
import { ArrCard } from "./ArrCard";
import { AutoDetect } from "./AutoDetect";
import { ExtraSonarrCard } from "./ExtraSonarrCard";
import { ListsCard } from "./ListsCard";
import { MediaCard } from "./MediaCard";
import { AutoAddCard } from "./AutoAddCard";
import { PicksSettings } from "./PicksSettings";
import { Security } from "./Security";
import { useSettings } from "./useSettings";
import { ErrorBox } from "../components/ui";
import { usePageTitle } from "../hooks/usePageTitle";

const TABS = [
  { id: "connections", label: "Connections" },
  { id: "picks", label: "Picks & filters" },
  { id: "alerts", label: "Alerts" },
  { id: "security", label: "Security" },
] as const;
type Tab = (typeof TABS)[number]["id"];

export function Settings({ status, onSaved }: { status: Status; onSaved: () => void }) {
  usePageTitle("Settings");
  const { s, setS, save, error } = useSettings();
  // Streaming-only users start on Picks & filters; server users on Connections. A tab they pick is remembered.
  const [tab, setTabRaw] = useState<Tab>(
    () => store.get<Tab | null>("settingsTab", null) ?? (status.mode === "stream" ? "picks" : "connections"),
  );
  const setTab = (t: Tab) => (setTabRaw(t), store.set("settingsTab", t));

  // Decided once per visit, so saving Sonarr inside the folded section doesn't reshuffle the page.
  const [streamLayout] = useState(status.mode === "stream" && !status.sonarr && !status.radarr && !status.media);
  const saveAndNotify = async (patch: Partial<S>) => {
    const r = await save(patch);
    onSaved();
    return r;
  };

  if (error) return <ErrorBox error={error} retry={() => location.reload()} />;
  if (!s) return <p className="muted">Loading settings…</p>;

  return (
    <section className="settings">
      <div className="toolbar">
        <h1>Settings</h1>
        <Link to="/setup" className="button ghost small">
          Setup guide
        </Link>
      </div>
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "on" : ""} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === "connections" &&
        (streamLayout ? (
          <>
            <ListsCard s={s} save={saveAndNotify} />
            <details className="card pad">
              <summary>Media server apps (optional: Sonarr, Radarr, Plex, Jellyfin)</summary>
              <ServerCards s={s} setS={setS} save={saveAndNotify} />
            </details>
          </>
        ) : (
          <>
            <ServerCards s={s} setS={setS} save={saveAndNotify} />
            <ListsCard s={s} save={saveAndNotify} />
          </>
        ))}
      {tab === "picks" && (
        <>
          <PicksSettings s={s} save={saveAndNotify} />
          {(status.sonarr || status.radarr) && <AutoAddCard s={s} save={saveAndNotify} />}
        </>
      )}
      {tab === "alerts" && <AlertsCard s={s} save={saveAndNotify} />}
      {tab === "security" && <Security s={s} status={status} save={saveAndNotify} />}
    </section>
  );
}

function ServerCards({ s, setS, save }: { s: S; setS: (s: S) => void; save: (p: Partial<S>) => Promise<S> }) {
  // Cards remount after "Find my apps" fills in an address, so they show (and keep) what was detected.
  const [gen, setGen] = useState(0);
  return (
    <>
      <AutoDetect onUsed={() => api<S>("/settings").then((x) => (setS(x), setGen((g) => g + 1)))} />
      <ArrCard key={`sonarr-${gen}`} kind="sonarr" s={s} save={save} />
      <ExtraSonarrCard s={s} onChange={() => api<S>("/settings").then(setS)} />
      <ArrCard key={`radarr-${gen}`} kind="radarr" s={s} save={save} />
      <MediaCard s={s} save={save} />
    </>
  );
}
