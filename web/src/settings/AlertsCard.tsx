import { useState } from "react";
import { api, type Settings } from "../api";
import { NumberInput, SecretInput, useToast } from "../components/ui";
import type { Save } from "./useSettings";
import { errorMessage } from "../lib/errors";

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
      toast(errorMessage(e), true);
    } finally {
      setBusy(false);
    }
  }

  const copy = (text: string) =>
    navigator.clipboard?.writeText(text).then(
      () => toast("Copied"),
      () => toast("Couldn't copy, select it and copy by hand", true),
    );
  return (
    <div className="card pad stack">
      <h2>Phone alerts</h2>
      <ol className="howto-steps small">
        <li>
          Install the free{" "}
          <a href="https://ntfy.sh" target="_blank" rel="noreferrer">
            ntfy
          </a>{" "}
          app on your phone.
        </li>
        <li>
          In the app, tap + and subscribe to a made-up name only you'd guess, like <code>{example}</code>.
        </li>
        <li>Type the same name below, then press "Save & send test".</li>
      </ol>
      <div className="form">
        <label>
          ntfy topic name
          {/* Topics are case-sensitive: phones must not capitalise or "correct" them. */}
          <input
            value={n.ntfyUrl}
            placeholder={example}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setN({ ...n, ntfyUrl: e.target.value })}
          />
        </label>
        <label className="check">
          <input type="checkbox" checked={n.airingAlerts} onChange={(e) => setN({ ...n, airingAlerts: e.target.checked })} /> When a show I
          follow has a new episode
        </label>
        <label className="check">
          <input type="checkbox" checked={n.seasonAlerts} onChange={(e) => setN({ ...n, seasonAlerts: e.target.checked })} /> When next
          season's picks are ready
        </label>
        {server && (
          <label className="check">
            <input type="checkbox" checked={n.episodeAlerts} onChange={(e) => setN({ ...n, episodeAlerts: e.target.checked })} /> When
            Sonarr/Radarr finishes downloading
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
                <NumberInput
                  label="Minutes to wait"
                  min={0}
                  max={1440}
                  value={n.airingDelayMin}
                  onChange={(v) => setN({ ...n, airingDelayMin: v })}
                />
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
