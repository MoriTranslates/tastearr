import { useCallback, useEffect, useState } from "react";
import { api, type Status } from "./api";
import { Login } from "./pages/Login";
import { Picks } from "./pages/Picks";
import { Quiz } from "./pages/Quiz";
import { Settings } from "./pages/Settings";
import { Setup } from "./pages/Setup";
import { Shows } from "./pages/Shows";
import { System } from "./pages/System";
import { Taste } from "./pages/Taste";
import { Wizard } from "./pages/Wizard";
import { ToastProvider } from "./ui";

const NAV = [
  { path: "/", label: "Picks", icon: "★" },
  { path: "/shows", label: "My Shows", icon: "▶" },
  { path: "/taste", label: "Taste", icon: "♥" },
  { path: "/settings", label: "Settings", icon: "⚙" },
] as const;

export function navigate(path: string) {
  history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function Link({ to, children, className }: { to: string; children: React.ReactNode; className?: string }) {
  return (
    <a href={to} className={className} onClick={(e) => (e.preventDefault(), navigate(to))}>
      {children}
    </a>
  );
}

export function App() {
  const [path, setPath] = useState(location.pathname);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await api<Status>("/status"));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
    const onPop = () => {
      setPath(location.pathname);
      document.getElementById("main")?.focus();
    };
    const onAuth = () => void refreshStatus();
    window.addEventListener("popstate", onPop);
    window.addEventListener("tastearr:auth", onAuth);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("tastearr:auth", onAuth);
    };
  }, [refreshStatus]);

  if (error && !status)
    return (
      <div className="center-msg">
        <p>Can't reach Tastearr: {error}</p>
        <button onClick={() => void refreshStatus()}>Try again</button>
      </div>
    );
  if (!status) return <div className="center-msg">Loading…</div>;
  if (status.setupRequired) return <Setup onDone={refreshStatus} />;
  if (!status.loggedIn) return <Login onDone={refreshStatus} />;

  // Nothing connected yet: the picks page has nothing to learn from, so show the setup guide instead.
  const noSources = !status.sonarr && !status.radarr && !status.media && !status.lists && !status.quizAnswers;
  const page = path === "/setup" || (noSources && path === "/") ? "setup" : path === "/quiz" ? "quiz" : path === "/system" ? "system" : NAV.find((n) => n.path === path)?.path ?? "/";

  return (
    <ToastProvider>
      <div className="app">
        <a className="skip" href="#main">
          Skip to content
        </a>
        <header className="topbar">
          <Link to="/" className="brand">
            <img src="/favicon.svg" alt="" width={28} height={28} />
            <span>Tastearr</span>
          </Link>
          <nav className="topnav" aria-label="Main">
            {NAV.map((n) => (
              <Link key={n.path} to={n.path} className={n.path === page ? "active" : ""}>
                {n.label}
              </Link>
            ))}
          </nav>
        </header>
        <main id="main" tabIndex={-1}>
          {page === "setup" && <Wizard status={status} onDone={refreshStatus} />}
          {page === "/" && <Picks status={status} />}
          {page === "/shows" && <Shows status={status} />}
          {page === "/taste" && <Taste />}
          {page === "quiz" && <Quiz onDone={refreshStatus} />}
          {page === "/settings" && <Settings status={status} onSaved={refreshStatus} />}
          {page === "system" && <System />}
        </main>
        <footer className="foot">
          Tastearr v{status.version} · data from <a href="https://anilist.co">AniList</a> · <Link to="/system">System</Link> · GPL-3.0
        </footer>
        <nav className="tabbar" aria-label="Main">
          {NAV.map((n) => (
            <Link key={n.path} to={n.path} className={n.path === page ? "active" : ""}>
              <span aria-hidden="true">{n.icon}</span>
              {n.label}
            </Link>
          ))}
        </nav>
      </div>
    </ToastProvider>
  );
}
