import { useEffect, useRef, useState } from "react";
import { api, type Settings } from "../api";
import { Chips, Pill, SecretInput, useToast } from "../components/ui";
import type { Save } from "./useSettings";

interface PlexServer {
  id: string;
  name: string;
  owned: boolean;
  urls: string[];
}

export function MediaCard({ s, save, onSaved }: { s: Settings; save: Save; onSaved?: () => void }) {
  const toast = useToast();
  const m = s.media;
  const [type, setType] = useState(m.type);
  const [url, setUrl] = useState(m.url);
  const [token, setToken] = useState(m.token);
  const [userId, setUserId] = useState(m.userId);
  const [libs, setLibs] = useState<{ id: string; title: string }[] | null>(null);
  const [libraryIds, setLibraryIds] = useState(m.libraryIds);
  const [users, setUsers] = useState<{ id: string; name: string }[]>([]);
  const [info, setInfo] = useState<string | null>(null);
  const [plex, setPlex] = useState<{ pinId: number; servers: PlexServer[] | null } | null>(null);
  const [serverPick, setServerPick] = useState<{ id: string; url: string }>({ id: "", url: "" });
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [manual, setManual] = useState(false);
  // Each sign-in attempt has its own number; Cancel, a new attempt or leaving the page ends the old polling loop.
  const attempt = useRef(0);
  useEffect(
    () => () => {
      attempt.current++;
    },
    [],
  );

  useEffect(() => {
    if (m.type !== "none" && m.url && m.token) void test(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function test(quiet = false) {
    setBusy(true);
    try {
      const r = await api<{
        name: string;
        version: string;
        users: { id: string; name: string }[];
        libraries: { id: string; title: string }[];
      }>("/media/test", { body: { type, url, token, userId } });
      setInfo(`${r.name} · v${r.version}`);
      setFailed(false);
      setUsers(r.users);
      setLibs(r.libraries);
    } catch (e) {
      setInfo(null);
      setFailed(true);
      if (!quiet) toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }

  async function plexSignIn() {
    const mine = ++attempt.current;
    const popup = window.open("about:blank", "plexauth", "width=600,height=700");
    try {
      const pin = await api<{ id: number; authUrl: string }>("/plex/pin", { body: {} });
      if (popup) popup.location.href = pin.authUrl;
      else window.open(pin.authUrl, "_blank");
      setPlex({ pinId: pin.id, servers: null });
      for (let i = 0; i < 120; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        if (attempt.current !== mine) return;
        if (popup?.closed && i > 2) {
          // The popup closes itself after approving, so check once more before giving up.
          const last = await api<{ done: boolean }>(`/plex/pin/${pin.id}`).catch(() => ({ done: false }));
          if (!last.done) {
            setPlex(null);
            return;
          }
        }
        const r = await api<{ done: boolean; servers?: PlexServer[] }>(`/plex/pin/${pin.id}`);
        if (r.done) {
          popup?.close();
          setPlex({ pinId: pin.id, servers: r.servers ?? [] });
          const first = r.servers?.find((x) => x.owned) ?? r.servers?.[0];
          if (first) setServerPick({ id: first.id, url: first.urls[0] ?? "" });
          return;
        }
      }
      toast("Plex sign-in timed out", true);
    } catch (e) {
      popup?.close();
      toast((e as Error).message, true);
    }
  }

  async function usePlexServer() {
    if (!plex) return;
    setBusy(true);
    try {
      const r = await api<{ name: string; version: string; libraries: { id: string; title: string }[] }>("/plex/server", {
        body: { pinId: plex.pinId, serverId: serverPick.id, url: serverPick.url },
      });
      setInfo(`${r.name} · v${r.version}`);
      setLibs(r.libraries);
      setType("plex");
      setUrl(serverPick.url);
      setToken("••••••••");
      setPlex(null);
      toast(`Connected to ${r.name}. Now tick your anime libraries and save.`);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    setBusy(true);
    try {
      await save({ media: { type, url, token, userId, libraryIds } });
      toast("Watch history saved");
      onSaved?.();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }

  const server = plex?.servers?.find((x) => x.id === serverPick.id);
  const configuredPlex = m.type === "plex" && !!m.url && !!m.token;
  return (
    <div className="card pad stack">
      <div className="card-head">
        <h2>Watch history</h2>
        <Pill ok={info ? true : failed || m.type === "none" ? false : null}>
          {info ?? (failed ? "Can't connect" : m.type === "none" ? "Not set up" : "Saved")}
        </Pill>
      </div>
      <p className="muted small">
        <strong>Read-only.</strong> Tastearr reads how many episodes you've watched of each show. Finished shows count strongly toward your
        taste and shows you dropped early count against it. It never changes anything on your media server. Skip this if you'd rather use
        AniList/MAL or the quiz.
      </p>
      <div className="seg" role="radiogroup" aria-label="Media server">
        {(["none", "plex", "jellyfin"] as const).map((t) => (
          <button key={t} role="radio" aria-checked={type === t} className={type === t ? "on" : ""} onClick={() => setType(t)}>
            {t === "none" ? "None" : t === "plex" ? "Plex" : "Jellyfin / Emby"}
          </button>
        ))}
      </div>
      {type === "plex" && (
        <>
          {configuredPlex && (
            <p className="small">
              Connected to <code>{m.url}</code>.{" "}
              <button className="linklike small" onClick={() => test()}>
                Test again
              </button>
            </p>
          )}
          <div className="row">
            <button className="primary plex" onClick={plexSignIn} disabled={busy || (!!plex && !plex.servers)}>
              {configuredPlex ? "Sign in with Plex again" : "Sign in with Plex"}
            </button>
            <button className="linklike small" onClick={() => setManual(!manual)}>
              {manual ? "Hide" : "Enter address and token instead"}
            </button>
          </div>
          <p className="muted small">
            Signing in gives Tastearr its own access, which you can remove any time in Plex → Authorized Devices. Your Plex password never
            touches Tastearr.
          </p>
          {plex && !plex.servers && (
            <p className="muted small">
              Waiting for you to approve in the Plex window…{" "}
              <button
                className="linklike small"
                onClick={() => {
                  attempt.current++;
                  setPlex(null);
                }}
              >
                Cancel
              </button>
            </p>
          )}
          {manual && (
            <div className="form">
              <label>
                Address
                <input value={url} placeholder="http://192.168.1.10:32400" onChange={(e) => setUrl(e.target.value)} />
              </label>
              <label>
                Plex token
                <SecretInput label="Plex token" value={token} onChange={setToken} />
              </label>
              <div className="row wide">
                <button className="ghost" disabled={busy || !url} onClick={() => test()}>
                  Test
                </button>
              </div>
            </div>
          )}
          {plex?.servers && (
            <div className="form">
              <label>
                Server
                <select
                  value={serverPick.id}
                  onChange={(e) =>
                    setServerPick({ id: e.target.value, url: plex.servers!.find((x) => x.id === e.target.value)?.urls[0] ?? "" })
                  }
                >
                  {plex.servers.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                      {x.owned ? "" : " (shared)"}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Address
                <select value={serverPick.url} onChange={(e) => setServerPick({ ...serverPick, url: e.target.value })}>
                  {server?.urls.map((u) => (
                    <option key={u} value={u}>
                      {u}
                    </option>
                  ))}
                </select>
              </label>
              <div className="row end wide">
                <button className="primary" onClick={usePlexServer} disabled={busy || !serverPick.url}>
                  Use this server
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {type === "jellyfin" && (
        <div className="form">
          <label>
            Address
            <input value={url} placeholder="http://192.168.1.10:8096" onChange={(e) => setUrl(e.target.value)} />
          </label>
          <label>
            API key <span className="muted small">(Dashboard → API Keys)</span>
            <SecretInput label="Jellyfin API key" value={token} onChange={setToken} />
          </label>
          {users.length > 0 && (
            <label>
              Whose watch history?
              <select value={userId} onChange={(e) => setUserId(e.target.value)}>
                <option value="">Choose…</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="row wide">
            <button className="ghost" disabled={busy || !url} onClick={() => test()}>
              Test
            </button>
          </div>
        </div>
      )}
      {libs && type !== "none" && (
        <div className="field">
          <span>Anime libraries (none ticked = all show libraries)</span>
          <Chips label="Libraries" options={libs.map((l) => ({ id: l.id, label: l.title }))} value={libraryIds} onChange={setLibraryIds} />
        </div>
      )}
      <div className="row end">
        <button className="primary" disabled={busy} onClick={submit}>
          Save watch history
        </button>
      </div>
    </div>
  );
}
