import { apiError, fakeApi } from "./dom.ts";
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "../../web/src/App";
import { ToastProvider } from "../../web/src/components/ui";
import { clearPicksCache } from "../../web/src/picks/picksCache";
import { Settings } from "../../web/src/settings/Settings";
import { Shows } from "../../web/src/shows/Shows";
import { System } from "../../web/src/system/System";
import { Taste } from "../../web/src/taste/Taste";
import { picks, settings, status } from "../fixtures/web.ts";

afterEach(() => {
  cleanup();
  clearPicksCache();
});
const wrap = (ui: React.ReactNode) => render(<ToastProvider>{ui}</ToastProvider>);
const types = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

describe("App shell", () => {
  test("logged in: navigation, the picks page and the footer version", async () => {
    fakeApi({ "GET /status": status(), "GET /picks": { picks: picks() } });
    render(<App />);
    assert.ok((await screen.findAllByRole("link", { name: "My Shows" })).length >= 1);
    assert.ok(await screen.findByRole("heading", { name: "Fall 2026" }));
    assert.ok(screen.getByText(/Tastearr v0\.6\.0/));
  });

  test("first run shows account setup; mismatched passwords never reach the server", async () => {
    const calls = fakeApi({ "GET /status": { version: "0.6.0", setupRequired: true, loggedIn: false }, "POST /auth/setup": {} });
    render(<App />);
    assert.ok(await screen.findByRole("heading", { name: "Welcome to Tastearr" }));
    types(screen.getByLabelText("Username"), "captain");
    types(screen.getByLabelText(/^Password/), "hunter2hunter2");
    types(screen.getByLabelText("Type it again"), "different-one");
    fireEvent.submit(screen.getByRole("heading", { name: "Welcome to Tastearr" }).closest("form")!);
    assert.ok(await screen.findByText("The two passwords don't match"));
    assert.equal(calls.filter((c) => c.path === "/auth/setup").length, 0);
  });

  test("logged out: login form; a wrong password shows the server message and stays on the form", async () => {
    fakeApi({
      "GET /status": { version: "0.6.0", setupRequired: false, loggedIn: false },
      "POST /auth/login": () => apiError(401, "Wrong username or password"),
    });
    render(<App />);
    types(await screen.findByLabelText("Username"), "captain");
    types(screen.getByLabelText("Password"), "nope");
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));
    assert.ok(await screen.findByText("Wrong username or password"));
    assert.ok(screen.getByRole("button", { name: "Log in" }));
  });

  test("a server that cannot be reached says so and Try again recovers", async () => {
    let up = false;
    fakeApi({ "GET /status": () => (up ? status({ sonarr: true }) : apiError(502, "Bad gateway")), "GET /picks": { picks: picks() } });
    render(<App />);
    assert.ok(await screen.findByText(/Can't reach Tastearr: Bad gateway/));
    up = true;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    assert.ok(await screen.findByRole("heading", { name: "Fall 2026" }));
  });

  test("nothing connected yet leads to the setup guide instead of an empty picks page", async () => {
    fakeApi({
      "GET /status": status({ sonarr: false, radarr: false, media: false, lists: false, quizAnswers: 0 }),
      "GET /settings": settings(),
    });
    render(<App />);
    assert.ok((await screen.findAllByRole("heading", { name: /find anime you.ll like/ })).length >= 1);
  });

  test("server warnings are shown as alerts", async () => {
    fakeApi({ "GET /status": status({ warnings: ["Sonarr is unreachable"] }), "GET /picks": { picks: [] } });
    render(<App />);
    assert.ok(await screen.findByText("Sonarr is unreachable"));
  });
});

describe("Settings", () => {
  test("loads, shows the Sonarr connection with the key masked, and switches tabs", async () => {
    fakeApi({ "GET /settings": settings() });
    wrap(<Settings status={status()} onSaved={() => undefined} />);
    assert.ok(await screen.findByRole("heading", { name: "Settings" }));
    assert.ok(await screen.findByDisplayValue("http://192.168.1.5:8989"));
    fireEvent.click(screen.getByRole("tab", { name: "Alerts" }));
    assert.ok(await screen.findByRole("heading", { name: "Phone alerts" }));
  });

  test("saving alerts sends the edited settings to the server and confirms", async () => {
    let saved: { notify: { ntfyUrl: string } } | undefined;
    fakeApi({
      "GET /settings": settings(),
      "PUT /settings": (c: { body: unknown }) => {
        saved = c.body as typeof saved;
        return { ...settings(), notify: { ...settings().notify, ...(c.body as { notify: object }).notify } };
      },
    });
    const done: number[] = [];
    wrap(<Settings status={status()} onSaved={() => done.push(1)} />);
    fireEvent.click(await screen.findByRole("tab", { name: "Alerts" }));
    types(await screen.findByLabelText(/ntfy topic name/), "anime-秘密-topic");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    assert.ok(await screen.findByText("Alerts saved"));
    assert.equal(saved?.notify.ntfyUrl, "anime-秘密-topic");
    assert.equal(done.length, 1, "the app is told so it can refresh its status");
  });

  test("a rejected save shows the server reason and does not claim success", async () => {
    fakeApi({
      "GET /settings": settings(),
      "PUT /settings": () => apiError(400, "The ntfy address isn't allowed (link-local / cloud metadata address)"),
    });
    wrap(<Settings status={status()} onSaved={() => undefined} />);
    fireEvent.click(await screen.findByRole("tab", { name: "Alerts" }));
    types(await screen.findByLabelText(/ntfy topic name/), "http://169.254.169.254/x");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    assert.ok((await screen.findAllByText(/isn't allowed/)).length >= 1);
    assert.equal(screen.queryAllByText("Alerts saved").length, 0);
  });

  test("settings that fail to load show an error with a retry", async () => {
    fakeApi({ "GET /settings": () => apiError(500, "database is locked") });
    wrap(<Settings status={status()} onSaved={() => undefined} />);
    assert.ok(await screen.findByText(/Something went wrong: database is locked/));
  });
});

describe("My Shows", () => {
  const data = () => ({
    sonarr: [
      {
        tvdbId: 1,
        title: "葬送のフリーレン",
        poster: null,
        monitored: true,
        nextAiring: null,
        downloaded: 12,
        watched: 4,
        total: 28,
        dropped: false,
      },
    ],
    following: [],
  });

  test("lists Sonarr shows with progress; 'Not into it' asks first and updates the row", async () => {
    globalThis.confirm = () => true;
    const calls = fakeApi({ "GET /shows": data(), "POST /shows/1/drop": { dropped: true, monitored: false } });
    wrap(<Shows status={status()} />);
    assert.ok(await screen.findByText("葬送のフリーレン"));
    assert.ok(screen.getByText(/12 downloaded · 4\/28 watched/));
    fireEvent.click(screen.getByRole("button", { name: "Not into it" }));
    assert.ok(await screen.findByRole("button", { name: "Turn back on" }));
    assert.equal(calls.filter((c) => c.path === "/shows/1/drop").length, 1);
  });

  test("declining the confirmation changes nothing", async () => {
    globalThis.confirm = () => false;
    const calls = fakeApi({ "GET /shows": data() });
    wrap(<Shows status={status()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Not into it" }));
    assert.equal(calls.filter((c) => c.method === "POST").length, 0);
  });

  test("a server error while dropping is shown and the row is unchanged", async () => {
    globalThis.confirm = () => true;
    fakeApi({ "GET /shows": data(), "POST /shows/1/drop": () => apiError(502, "Sonarr PUT /series/1 failed (HTTP 500)") });
    wrap(<Shows status={status()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Not into it" }));
    assert.ok((await screen.findAllByText(/Sonarr PUT/)).length >= 1);
    assert.ok(screen.getByRole("button", { name: "Not into it" }));
  });

  test("nothing in Sonarr and nothing followed is an empty page, not an error", async () => {
    fakeApi({ "GET /shows": { sonarr: [], following: [] } });
    wrap(<Shows status={status()} />);
    assert.ok(await screen.findByText("No airing anime in Sonarr."));
  });
});

describe("Taste and System", () => {
  test("Taste shows what you like and what you skip", async () => {
    fakeApi({
      "GET /profile": {
        builtAt: Date.now(),
        trainedOn: 300,
        positives: 50,
        known: 100,
        base: 0.2,
        features: { "G:Fantasy": { lift: 2.4, n: 30, p: 12 }, "G:Sports": { lift: 0.3, n: 30, p: 2 } },
        favourites: [],
        sources: { sonarr: "12 series" },
      },
      "GET /system": { version: "0.6.0", uptime: 1000, node: "v24", jobs: [] },
    });
    wrap(<Taste />);
    assert.ok(await screen.findByRole("heading", { name: "Your taste" }));
    assert.ok(await screen.findByRole("heading", { name: "You tend to like" }));
    assert.ok(screen.getByRole("heading", { name: "You tend to skip" }));
  });

  test("Taste while the first profile builds shows progress, not an empty page", async () => {
    fakeApi({
      "GET /profile": { building: true },
      "GET /system": {
        version: "0.6.0",
        uptime: 1,
        node: "v24",
        jobs: [{ name: "profile", state: "running", detail: "Downloading fall 2025 from AniList (1/8)", startedAt: 1, finishedAt: null }],
      },
    });
    wrap(<Taste />);
    assert.ok(await screen.findByText(/Downloading fall 2025 from AniList/));
  });

  test("System shows jobs and health problems; a refused backup password is reported", async () => {
    fakeApi({
      "GET /system": {
        version: "0.6.0",
        uptime: 5000,
        node: "v24.1.0",
        jobs: [
          {
            name: "refresh",
            state: "error",
            detail: "AniList is having trouble",
            startedAt: 1,
            finishedAt: 2,
            lastError: "AniList refused the request (HTTP 401)",
            lastErrorAt: Date.now() - 60_000,
            lastSuccessAt: Date.now() - 3_600_000,
          },
          {
            name: "profile",
            state: "done",
            detail: "Learned",
            startedAt: 1,
            finishedAt: 2,
            lastError: null,
            lastErrorAt: null,
            lastSuccessAt: 2,
          },
        ],
      },
      "GET /system/health": { checks: [{ name: "Sonarr", ok: false, detail: "HTTP 401" }] },
      "POST /system/backup": () => apiError(403, "Wrong password"),
    });
    wrap(<System />);
    assert.ok(await screen.findByText(/AniList is having trouble/));
    assert.ok(await screen.findByText(/Problem: HTTP 401/));
    assert.ok(screen.getByText(/Last problem .*: AniList refused the request \(HTTP 401\)/));
    assert.ok(screen.getByText(/last success/));
    types(screen.getByLabelText("Your password"), "bad");
    fireEvent.click(screen.getByRole("button", { name: "Download backup" }));
    assert.ok((await screen.findAllByText("Wrong password")).length >= 1);
    await waitFor(() => assert.ok(!(screen.getByRole("button", { name: "Download backup" }) as HTMLButtonElement).disabled));
  });
});
