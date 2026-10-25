import { useEffect, useRef, useState } from "react";
import { api, type ArrOptions, type Settings } from "./api";
import { Chips, NumberInput, Pill, SecretInput, useToast } from "./ui";

type Save = (patch: Partial<Settings>) => Promise<Settings>;

export function useSettings() {
  const toast = useToast();
  const [s, setS] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<Settings>("/settings").then(setS).catch((e) => setError(e.message));
  }, []);
  const save: Save = async (patch) => {
    const next = await api<Settings>("/settings", { method: "PUT", body: patch });
    setS(next);
    return next;
  };
  return { s, setS, save, error, toast };
}

// ---------------------------------------------------------------- auto-detect

interface Found { id: string; app: "sonarr" | "radarr"; folder: string; port: number; url: string | null; usable: boolean }

export function AutoDetect({ onUsed }: { onUsed: () => void }) {
  const toast = useToast();
  const [res, setRes] = useState<{ appdata: boolean; docker: boolean; found: Found[] } | null>(null);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function scan() {
    setBusy(true);
    try {
      const r = await api<{ appdata: boolean; docker: boolean; found: Found[] }>("/discover");
      setRes(r);
      setUrls(Object.fromEntries(r.found.map((f) => [f.id, f.url ?? ""])));
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }

  async function use(f: Found) {
    try {
      await api("/discover/use", { body: { id: f.id, url: urls[f.id] } });
      toast(`Using ${f.folder} for ${f.app === "sonarr" ? "Sonarr" : "Radarr"}`);
      onUsed();
    } catch (e) {
      toast((e as Error).message, true);
    }
  }

  return (
    <div className="card pad stack">
      <h2>Find my apps</h2>
      <p className="muted small">
        If Sonarr's or Radarr's config folder is mounted into Tastearr (read-only, at <code>/appdata</code>), Tastearr can read the API key itself. You only confirm the address.
      </p>
      <button className="ghost" disabled={busy} onClick={scan}>
        {busy ? "Looking…" : "Look for Sonarr and Radarr"}
      </button>
      {res && !res.appdata && <p className="muted small">No config folder is mounted, so enter the details below instead.</p>}
      {res?.appdata && !res.found.length && <p className="muted small">Nothing found in /appdata.</p>}
      {res?.found.map((f) => (
        <div key={f.id} className="found">
          <strong>{f.app === "sonarr" ? "Sonarr" : "Radarr"}</strong>
          <span className="muted small">{f.folder}</span>
          {f.usable ? (
            <>
              <input aria-label={`${f.folder} address`} value={urls[f.id] ?? ""} placeholder={`http://server-ip:${f.port}`} onChange={(e) => setUrls({ ...urls, [f.id]: e.target.value })} />
              <button className="primary small" disabled={!urls[f.id]} onClick={() => use(f)}>
                Use
              </button>
            </>
          ) : (
            <span className="muted small">Enter this one below.</span>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- Sonarr / Radarr

/** Cards with edits that haven't been saved yet (by name). */
export const unsaved = new Set<string>();

/** More Sonarr instances (a separate anime or 4K Sonarr): used for "In library" and monitoring. Adds go to the main one. */
export function ExtraSonarrCard({ s, onChange }: { s: Settings; onChange: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState({ name: "", url: "", apiKey: "" });
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!s.sonarr.url) return null;
  async function add() {
    setBusy(true);
    try {
      await api("/sonarr/extra", { body: form });
      toast(`Added ${form.name || form.url}`);
      setForm({ name: "", url: "", apiKey: "" });
      setOpen(false);
      onChange();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  async function remove(i: number) {
    await api(`/sonarr/extra/${i}`, { method: "DELETE" }).catch((e) => toast((e as Error).message, true));
    onChange();
  }
  return (
    <div className="card pad stack">
      <h2>Other Sonarr instances</h2>
      <p className="muted small">Running a separate anime or 4K Sonarr? Add it so shows there count as "You have this" and can be monitored. New shows are added to the main Sonarr above.</p>
      {s.sonarrExtra.map((x, i) => (
        <div key={x.url} className="row">
          <strong>{x.name}</strong>
          <span className="muted small">{x.url}</span>
          <button className="ghost small" onClick={() => remove(i)}>
            Remove
          </button>
        </div>
      ))}
      {open ? (
        <div className="form">
          <label>
            Name
            <input value={form.name} placeholder="Sonarr 4K" onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label>
            Address
            <input value={form.url} placeholder="http://192.168.1.10:8990" onChange={(e) => setForm({ ...form, url: e.target.value })} />
          </label>
          <label>
            API key
            <SecretInput label="API key" value={form.apiKey} onChange={(v) => setForm({ ...form, apiKey: v })} />
          </label>
          <div className="row end">
            <button className="ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button className="primary" disabled={busy || !form.url || !form.apiKey} onClick={add}>
              {busy ? "Testing…" : "Test & add"}
            </button>
          </div>
        </div>
      ) : (
        <button className="ghost" onClick={() => setOpen(true)}>
          Add another Sonarr
        </button>
      )}
    </div>
  );
}

export function ArrCard({ kind, s, save, onSaved }: { kind: "sonarr" | "radarr"; s: Settings; save: Save; onSaved?: () => void }) {
  const toast = useToast();
  const cfg = s[kind];
  const [url, setUrl] = useState(cfg.url);
  const [apiKey, setApiKey] = useState(cfg.apiKey);
  const [opts, setOpts] = useState<ArrOptions | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [draft, setDraft] = useState(cfg);
  const [busy, setBusy] = useState(false);
  const name = kind === "sonarr" ? "Sonarr" : "Radarr";

  async function test(quiet = false) {
    setBusy(true);
    try {
      const r = await api<{ version: string; options: ArrOptions }>(`/${kind}/test`, { body: { url, apiKey } });
      setVersion(r.version);
      setFailed(false);
      setOpts(r.options);
    } catch (e) {
      setVersion(null);
      setFailed(true);
      if (!quiet) toast(`${name}: ${(e as Error).message}`, true);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (cfg.url && cfg.apiKey) void test(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit() {
    setBusy(true);
    try {
      const next = await save({ [kind]: { ...draft, url, apiKey } } as Partial<Settings>);
      setApiKey(next[kind].apiKey);
      toast(`${name} saved`);
      onSaved?.();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }

  // Lets the setup guide warn before "Next" throws away an address or key that wasn't saved.
  const dirty = url !== cfg.url || apiKey !== cfg.apiKey || JSON.stringify(draft) !== JSON.stringify(cfg);
  useEffect(() => {
    if (dirty) unsaved.add(name);
    else unsaved.delete(name);
    return () => void unsaved.delete(name);
  }, [dirty, name]);
  const connected = !!cfg.url && !!cfg.apiKey;
  return (
    <div className="card pad stack">
      <div className="card-head">
        <h2>{name}</h2>
        <Pill ok={version ? true : failed || !connected ? false : null}>{version ? `Connected · v${version}` : failed ? "Can't connect" : connected ? "Saved" : "Not set up"}</Pill>
      </div>
      <p className="muted small">
        {kind === "sonarr" ? (
          <>
            Tastearr reads your series list to learn what you picked, and adds anime you choose. It only changes Sonarr when you press <em>Add</em>, <em>Monitor</em> or{" "}
            <em>Not into it</em>, and it never deletes anything.
          </>
        ) : (
          <>Same as Sonarr, for anime movies: Tastearr reads your movie list and adds the movies you pick. It never deletes anything.</>
        )}
      </p>
      <div className="form">
        <label>
          Address
          <input value={url} placeholder={kind === "sonarr" ? "http://192.168.1.10:8989" : "http://192.168.1.10:7878"} onChange={(e) => setUrl(e.target.value)} />
        </label>
        <label>
          API key <span className="muted small">(Settings → General in {name})</span>
          <SecretInput label={`${name} API key`} value={apiKey} onChange={setApiKey} />
        </label>
      </div>
      <div className="row">
        <button className="ghost" disabled={busy || !url} onClick={() => test()}>
          Test
        </button>
      </div>
      {opts && (
        <div className="form">
          <label>
            Quality profile for {kind === "sonarr" ? "anime" : "anime movies"}
            <select value={draft.qualityProfileId ?? ""} onChange={(e) => setDraft({ ...draft, qualityProfileId: Number(e.target.value) || null })}>
              <option value="">Choose…</option>
              {opts.profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Root folder
            <select value={draft.rootFolderPath} onChange={(e) => setDraft({ ...draft, rootFolderPath: e.target.value })}>
              <option value="">Choose…</option>
              {opts.roots.map((r) => (
                <option key={r.id} value={r.path}>
                  {r.path}
                </option>
              ))}
            </select>
          </label>
          <div className="field wide">
            <span>Tags to add (a "tastearr" tag is always added too)</span>
            <Chips label="Tags" options={opts.tags.map((t) => ({ id: t.id, label: t.label }))} value={draft.tags} onChange={(tags) => setDraft({ ...draft, tags })} />
          </div>
          {kind === "sonarr" && "sequelMonitor" in draft && (
            <>
              <label>
                Sequels of shows you don't have
                <select value={draft.sequelMonitor} onChange={(e) => setDraft({ ...draft, sequelMonitor: e.target.value as "newSeason" | "all" })}>
                  <option value="newSeason">Only monitor the new season</option>
                  <option value="all">Monitor every season</option>
                </select>
              </label>
              <label>
                "Not into it anymore"
                <select value={draft.dropAction} onChange={(e) => setDraft({ ...draft, dropAction: e.target.value as "unmonitor" | "keep" })}>
                  <option value="unmonitor">Unmonitor the series in Sonarr</option>
                  <option value="keep">Only stop alerts</option>
                </select>
              </label>
            </>
          )}
          {kind === "radarr" && "minimumAvailability" in draft && (
            <label>
              Minimum availability
              <select value={draft.minimumAvailability} onChange={(e) => setDraft({ ...draft, minimumAvailability: e.target.value as "announced" | "inCinemas" | "released" })}>
                <option value="released">Released</option>
                <option value="inCinemas">In cinemas</option>
                <option value="announced">Announced</option>
              </select>
            </label>
          )}
          <label className="check">
            <input type="checkbox" checked={draft.searchOnAdd} onChange={(e) => setDraft({ ...draft, searchOnAdd: e.target.checked })} /> Search as soon as it's added
          </label>
        </div>
      )}
      <div className="row end">
        <button className="primary" disabled={busy || !url} onClick={submit}>
          Save {name}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Plex / Jellyfin

interface PlexServer { id: string; name: string; owned: boolean; urls: string[] }

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
      const r = await api<{ name: string; version: string; users: { id: string; name: string }[]; libraries: { id: string; title: string }[] }>("/media/test", { body: { type, url, token, userId } });
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
      const r = await api<{ name: string; version: string; libraries: { id: string; title: string }[] }>("/plex/server", { body: { pinId: plex.pinId, serverId: serverPick.id, url: serverPick.url } });
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
        <Pill ok={info ? true : failed || m.type === "none" ? false : null}>{info ?? (failed ? "Can't connect" : m.type === "none" ? "Not set up" : "Saved")}</Pill>
      </div>
      <p className="muted small">
        <strong>Read-only.</strong> Tastearr reads how many episodes you've watched of each show. Finished shows count strongly toward your taste and shows you dropped early count
        against it. It never changes anything on your media server. Skip this if you'd rather use AniList/MAL or the quiz.
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
          <p className="muted small">Signing in gives Tastearr its own access, which you can remove any time in Plex → Authorized Devices. Your Plex password never touches Tastearr.</p>
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
                <select value={serverPick.id} onChange={(e) => setServerPick({ id: e.target.value, url: plex.servers!.find((x) => x.id === e.target.value)?.urls[0] ?? "" })}>
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

// ---------------------------------------------------------------- AniList / MAL

export function ListsCard({ s, save, onSaved }: { s: Settings; save: Save; onSaved?: () => void }) {
  const toast = useToast();
  const [lists, setLists] = useState(s.lists);
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    try {
      await save({ lists });
      const r = await api<{ imported: string[] }>("/lists/import", { body: {} });
      toast(r.imported.length ? `Imported ${r.imported.join(" and ")}. Rebuilding your taste…` : "Saved");
      onSaved?.();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="card pad stack">
      <div className="card-head">
        <h2>AniList / MyAnimeList</h2>
        <Pill ok={s.lists.anilistUser || s.lists.malUser ? true : false}>{s.lists.anilistUser || s.lists.malUser ? "Linked" : "Not set up"}</Pill>
      </div>
      <p className="muted small">
        The fastest way to teach Tastearr: your public list's completed shows, scores and drops. Only the username is needed for AniList.
      </p>
      <div className="form">
        <label>
          AniList username
          <input value={lists.anilistUser} placeholder="e.g. morisato" onChange={(e) => setLists({ ...lists, anilistUser: e.target.value })} />
        </label>
        <label>
          MyAnimeList username
          <input value={lists.malUser} onChange={(e) => setLists({ ...lists, malUser: e.target.value })} />
        </label>
        {lists.malUser && (
          <label>
            MAL API client ID{" "}
            <a className="small" href="https://myanimelist.net/apiconfig" target="_blank" rel="noreferrer">
              (get one free)
            </a>
            <SecretInput label="MAL client ID" value={lists.malClientId} onChange={(v) => setLists({ ...lists, malClientId: v })} />
          </label>
        )}
      </div>
      <div className="row end">
        <button className="primary" disabled={busy} onClick={submit}>
          {busy ? "Importing…" : "Save & import"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- alerts

export function AlertsCard({ s, save, simple }: { s: Settings; save: Save; simple?: boolean }) {
  const toast = useToast();
  const [n, setN] = useState(s.notify);
  const [ext, setExt] = useState(s.externalUrl);
  const [busy, setBusy] = useState(false);
  const [moreOpen, setMoreOpen] = useState(!!(s.notify.gotifyUrl || s.notify.discordWebhook));
  const base = ext || location.origin;
  const server = s.mode !== "stream" && !simple;
  const [example] = useState(() => `anime-${Math.random().toString(36).slice(2, 8)}`);

  async function submit(thenTest = false) {
    setBusy(true);
    try {
      const saved = await save({ notify: n, externalUrl: ext });
      setN(saved.notify);
      if (thenTest) {
        const r = await api<{ sent: string[] }>("/notify/test", { body: {} });
        toast(r.sent.length ? `Test sent to ${r.sent.join(", ")}. Check your phone.` : "Nothing set up to send to yet", !r.sent.length);
      } else toast("Alerts saved");
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }

  const copy = (text: string) => navigator.clipboard?.writeText(text).then(() => toast("Copied"), () => toast("Couldn't copy, select it and copy by hand", true));
  return (
    <div className="card pad stack">
      <h2>Phone alerts</h2>
      <ol className="howto-steps small">
        <li>
          Install the free <a href="https://ntfy.sh" target="_blank" rel="noreferrer">ntfy</a> app on your phone.
        </li>
        <li>In the app, tap + and subscribe to a made-up name only you'd guess, like <code>{example}</code>.</li>
        <li>Type the same name below, then press "Save & send test".</li>
      </ol>
      <div className="form">
        <label>
          ntfy topic name
          {/* Topics are case-sensitive: phones must not capitalise or "correct" them. */}
          <input value={n.ntfyUrl} placeholder={example} autoCapitalize="none" autoCorrect="off" spellCheck={false} autoComplete="off" onChange={(e) => setN({ ...n, ntfyUrl: e.target.value })} />
        </label>
        <label className="check">
          <input type="checkbox" checked={n.airingAlerts} onChange={(e) => setN({ ...n, airingAlerts: e.target.checked })} /> When a show I follow has a new episode
        </label>
        <label className="check">
          <input type="checkbox" checked={n.seasonAlerts} onChange={(e) => setN({ ...n, seasonAlerts: e.target.checked })} /> When next season's picks are ready
        </label>
        {server && (
          <label className="check">
            <input type="checkbox" checked={n.episodeAlerts} onChange={(e) => setN({ ...n, episodeAlerts: e.target.checked })} /> When Sonarr/Radarr finishes downloading
          </label>
        )}
      </div>
      <div className="row end">
        <button className="ghost" disabled={busy} onClick={() => submit(false)}>
          Save
        </button>
        <button className="primary" disabled={busy} onClick={() => submit(true)}>
          Save & send test
        </button>
      </div>
      {!simple && (
        <>
          <button className="linklike small left" aria-expanded={moreOpen} onClick={() => setMoreOpen(!moreOpen)}>
            {moreOpen ? "Fewer options" : "More options (Gotify, Discord, timing, buttons)"}
          </button>
          {moreOpen && (
            <div className="form">
              <label>
                ntfy access token (only for a private ntfy server)
                <SecretInput label="ntfy token" value={n.ntfyToken} onChange={(v) => setN({ ...n, ntfyToken: v })} />
              </label>
              <label>
                Gotify address
                <input value={n.gotifyUrl} onChange={(e) => setN({ ...n, gotifyUrl: e.target.value })} />
              </label>
              <label>
                Gotify app token
                <SecretInput label="Gotify token" value={n.gotifyToken} onChange={(v) => setN({ ...n, gotifyToken: v })} />
              </label>
              <label>
                Discord webhook
                <SecretInput label="Discord webhook" value={n.discordWebhook} onChange={(v) => setN({ ...n, discordWebhook: v })} />
              </label>
              <label>
                Wait this many minutes after it airs in Japan before saying an episode is out
                <NumberInput label="Minutes to wait" min={0} max={1440} value={n.airingDelayMin} onChange={(v) => setN({ ...n, airingDelayMin: v })} />
              </label>
              <label>
                Shows in the new-season alert
                <NumberInput label="Shows in alert" min={3} max={30} value={n.picks} onChange={(v) => setN({ ...n, picks: v })} />
              </label>
              {server && (
                <label className="wide">
                  Address your phone can reach Tastearr at (optional; adds a "Not into it anymore" button to alerts)
                  <input value={ext} placeholder="https://tastearr.example.com" onChange={(e) => setExt(e.target.value)} />
                </label>
              )}
            </div>
          )}
          {server && (
            <div className="howto">
              <h3>Download alerts from Sonarr / Radarr</h3>
              <ol>
                <li>In Sonarr (or Radarr) open Settings → Connect → + → Webhook.</li>
                <li>Tick "On Import" only, and paste this address:</li>
              </ol>
              {(["sonarr", "radarr"] as const).map((k) => {
                const u = `${base}/api/webhook/${k}/${s.webhookKey}`;
                return (
                  <div key={k} className="copyrow">
                    <span className="small muted">{k === "sonarr" ? "Sonarr" : "Radarr"}</span>
                    <code className="trunc">{u}</code>
                    <button className="ghost small" onClick={() => copy(u)}>
                      Copy
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
