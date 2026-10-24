import { useCallback, useEffect, useState } from "react";
import { api, type Status } from "./api";
import { Login } from "./pages/Login";
import { Picks } from "./pages/Picks";
import { Quiz } from "./pages/Quiz";
import { Settings } from "./pages/Settings";
import { Shows } from "./pages/Shows";
import { Taste } from "./pages/Taste";

const PAGES = [
  { path: "/", label: "Picks" },
  { path: "/shows", label: "My Shows" },
  { path: "/taste", label: "Taste" },
  { path: "/quiz", label: "Quiz" },
  { path: "/settings", label: "Settings" },
] as const;

export function navigate(path: string) {
  history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function App() {
  const [path, setPath] = useState(location.pathname);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = useCallback(() => api<Status>("/status").then(setStatus).catch((e) => setError(e.message)), []);

  useEffect(() => {
    refreshStatus();
    const onPop = () => setPath(location.pathname);
    const onLogout = () => refreshStatus();
    window.addEventListener("popstate", onPop);
    window.addEventListener("tastearr:logout", onLogout);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("tastearr:logout", onLogout);
    };
  }, [refreshStatus]);

  if (error) return <div className="center-msg">Can't reach Tastearr: {error}</div>;
  if (!status) return <div className="center-msg">Loading…</div>;
  if (status.authRequired && !status.loggedIn) return <Login onDone={refreshStatus} />;

  const needsSetup = !status.sonarr && !status.quizAnswers;
  const page = PAGES.find((p) => p.path === path) ?? PAGES[0];

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="/" onClick={(e) => (e.preventDefault(), navigate("/"))}>
          <img src="/favicon.svg" alt="" width={28} height={28} />
          <span>Tastearr</span>
        </a>
        <nav>
          {PAGES.map((p) => (
            <a key={p.path} href={p.path} className={p.path === page.path ? "active" : ""} onClick={(e) => (e.preventDefault(), navigate(p.path))}>
              {p.label}
            </a>
          ))}
        </nav>
      </header>
      <main>
        {needsSetup && page.path === "/" && (
          <div className="banner">
            New here? <a href="/settings" onClick={(e) => (e.preventDefault(), navigate("/settings"))}>Connect Sonarr and Plex/Jellyfin</a> so Tastearr can learn from your
            library, or <a href="/quiz" onClick={(e) => (e.preventDefault(), navigate("/quiz"))}>take the taste quiz</a>.
          </div>
        )}
        {page.path === "/" && <Picks status={status} />}
        {page.path === "/shows" && <Shows />}
        {page.path === "/taste" && <Taste />}
        {page.path === "/quiz" && <Quiz />}
        {page.path === "/settings" && <Settings onSaved={refreshStatus} />}
      </main>
      <footer className="foot">Tastearr v{status.version} · data from AniList · GPL-3.0</footer>
    </div>
  );
}
