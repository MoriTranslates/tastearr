import { apiError, fakeApi } from "./dom.ts";
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ToastProvider } from "../../web/src/components/ui";
import { Picks } from "../../web/src/picks/Picks";
import { clearPicksCache } from "../../web/src/picks/picksCache";
import type { AddPlan } from "../../shared/api.js";
import { pick, picks, status } from "../fixtures/web.ts";

afterEach(() => {
  cleanup();
  clearPicksCache();
});

const mount = (s = status()) =>
  render(
    <ToastProvider>
      <Picks status={s} />
    </ToastProvider>,
  );
const gone = (text: string | RegExp) => assert.equal(screen.queryAllByText(text).length, 0, `${text} should not be shown`);
const plan: AddPlan = {
  app: "sonarr",
  title: "葬送のフリーレン",
  year: 2023,
  monitor: "all",
  monitorLabel: "All seasons",
  season: 1,
  seasonListed: true,
  search: true,
  profile: "HD-1080p",
  rootFolder: "/tv",
  tags: ["tastearr"],
  options: [
    { value: "all", label: "All seasons" },
    { value: "future", label: "Only new episodes from now on" },
  ],
};

describe("Picks page", () => {
  test("renders the season: CJK titles, top pick, match percentage; hidden shows are tucked away", async () => {
    fakeApi({ "GET /picks": { picks: picks() } });
    mount();
    assert.ok(await screen.findByRole("heading", { name: "Fall 2026" }));
    assert.ok((await screen.findAllByText("葬送のフリーレン")).length >= 1);
    assert.ok(screen.getByText(/Top pick for you · 96% match/));
    assert.ok(screen.getAllByText("Quiet Slice").length >= 1);
    gone("Not For Me");
    assert.ok(screen.getAllByText("Already Owned").length >= 1, "owned shows show by default");
  });

  test("filters: 'show hidden ones' reveals the excluded pick; unticking 'already have' hides owned ones", async () => {
    fakeApi({ "GET /picks": { picks: picks() } });
    mount();
    await screen.findAllByText("Quiet Slice");
    fireEvent.click(screen.getByLabelText(/Show hidden ones/));
    assert.ok((await screen.findAllByText("Not For Me")).length >= 1);
    assert.ok(screen.getByText(/Hidden: You marked this/));
    fireEvent.click(screen.getByLabelText(/Show ones I already have/));
    await waitFor(() => gone("Already Owned"));
    assert.match(screen.getByRole("button", { name: /Filters/ }).textContent ?? "", /\(\d\)/, "active filters are counted");
  });

  test("filtering by streaming service keeps only shows on it; turning it off brings the rest back", async () => {
    fakeApi({ "GET /picks": { picks: picks() } });
    mount();
    await screen.findAllByText("Quiet Slice");
    const group = screen.getByRole("group", { name: "Where it streams" });
    fireEvent.click(within(group).getByRole("button", { name: "Netflix" }));
    await waitFor(() => gone("葬送のフリーレン"));
    assert.ok(screen.getAllByText("Quiet Slice").length >= 1);
    fireEvent.click(within(group).getByRole("button", { name: /Netflix/ }));
    assert.ok((await screen.findAllByText("葬送のフリーレン")).length >= 1);
  });

  test("when filters hide everything the page says so and 'Clear filters' brings the shows back", async () => {
    fakeApi({ "GET /picks": { picks: [pick(2, { title: "Quiet Slice", streaming: [{ site: "Netflix", url: "https://nf.example" }] })] } });
    mount(status({ prefs: { hideInLibrary: false, hideShorts: false, services: ["Crunchyroll"], dropAction: "unmonitor" } }));
    assert.ok(await screen.findByText(/Your filters hide everything \(1\)/));
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    assert.ok((await screen.findAllByText("Quiet Slice")).length >= 1);
  });

  test("empty season and failed load are explained; Try again refetches", async () => {
    fakeApi({ "GET /picks": { picks: [] } });
    mount();
    assert.ok(await screen.findByText(/hasn't announced anything for this season yet/));
    cleanup();
    clearPicksCache();
    let n = 0;
    fakeApi({ "GET /picks": () => (n++ === 0 ? apiError(500, "AniList is having trouble right now") : { picks: picks() }) });
    mount();
    assert.ok(await screen.findByText(/Something went wrong: AniList is having trouble/));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    assert.ok((await screen.findAllByText("Quiet Slice")).length >= 1);
  });

  test("season arrows request the neighbouring season", async () => {
    const calls = fakeApi({ "GET /picks": { picks: [pick(1)] } });
    mount();
    await screen.findAllByRole("button", { name: /Add to Sonarr/ });
    fireEvent.click(screen.getByRole("button", { name: "Next season" }));
    assert.ok(await screen.findByRole("heading", { name: "Winter 2027" }));
    await waitFor(() => assert.ok(calls.some((c) => c.path.includes("season=WINTER&year=2027"))));
  });
});

describe("Add dialog", () => {
  test("previews what will happen, Add posts it, and the card becomes 'You have this'", async () => {
    const calls = fakeApi({
      "GET /picks": { picks: [pick(1, { title: "葬送のフリーレン", match: 96 })] },
      "GET /picks/1/plan": plan,
      "POST /picks/1/add": { title: "葬送のフリーレン", monitored: "All seasons" },
    });
    mount();
    fireEvent.click((await screen.findAllByRole("button", { name: /Add to Sonarr/ }))[0]);
    const dialog = await screen.findByRole("dialog", { name: "Add 葬送のフリーレン" });
    assert.ok(await within(dialog).findByText(/Quality: HD-1080p/));
    assert.ok(within(dialog).getByText(/Folder: \/tv/));
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    await waitFor(() => assert.ok(!screen.queryByRole("dialog"), "dialog closed"));
    assert.deepEqual(calls.find((c) => c.path === "/picks/1/add")!.body, { monitor: "all", search: true });
    assert.ok((await screen.findAllByText("✓ You have this")).length >= 1);
    assert.ok(screen.getByText(/added to Sonarr \(all seasons\)/));
  });

  test("a failing add (Sonarr down) keeps the dialog open with the reason and marks nothing as added", async () => {
    fakeApi({
      "GET /picks": { picks: [pick(1)] },
      "GET /picks/1/plan": plan,
      "POST /picks/1/add": () => apiError(502, "Sonarr POST /series failed (HTTP 500)"),
    });
    mount();
    fireEvent.click((await screen.findAllByRole("button", { name: /Add to Sonarr/ }))[0]);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(await within(dialog).findByRole("button", { name: "Add" }));
    assert.ok(await within(dialog).findByText(/Sonarr POST \/series failed/));
    assert.ok(screen.getByRole("dialog"));
    assert.equal(screen.queryAllByText("✓ You have this").length, 0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    assert.ok(!screen.queryByRole("dialog"), "dialog closed");
  });

  test("a plan that fails to load shows the error instead of an endless spinner; Escape closes the dialog", async () => {
    fakeApi({ "GET /picks": { picks: [pick(1)] }, "GET /picks/1/plan": () => apiError(404, "Unknown show") });
    mount();
    fireEvent.click((await screen.findAllByRole("button", { name: /Add to Sonarr/ }))[0]);
    assert.ok(await screen.findByText("Unknown show"));
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => assert.ok(!screen.queryByRole("dialog"), "dialog closed"));
  });

  test("a show the community list can't match offers Sonarr's candidates and sends the chosen TVDB id", async () => {
    const calls = fakeApi({
      "GET /picks": { picks: [pick(7, { title: "Brand New", addVia: null, needsMatch: true, tvdbId: null })] },
      "GET /picks/7/plan": (c: { path: string }) =>
        c.path.includes("tvdbId=") ? { ...plan, title: "Brand New (TVDB)", seasons: [1] } : { app: "sonarr", needsMatch: true },
      "GET /picks/7/candidates": [
        {
          tvdbId: 999,
          title: "Brand New (TVDB)",
          year: 2026,
          network: "TV Tokyo",
          seasons: [1],
          overview: null,
          inLibrary: false,
          confident: true,
        },
      ],
      "POST /picks/7/add": { title: "Brand New (TVDB)", monitored: "All seasons" },
    });
    mount();
    fireEvent.click((await screen.findAllByRole("button", { name: /Add to Sonarr/ }))[0]);
    fireEvent.click(await screen.findByRole("button", { name: /Brand New \(TVDB\)/ }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(await within(dialog).findByRole("button", { name: "Add" }));
    await waitFor(() => assert.ok(calls.some((c) => c.path === "/picks/7/add")));
    assert.equal((calls.find((c) => c.path === "/picks/7/add")!.body as { tvdbId: number }).tvdbId, 999);
  });
});

describe("rating and following", () => {
  test("thumbs-down is sent to the server and Undo sends the previous verdict back", async () => {
    const calls = fakeApi({ "GET /picks": { picks: [pick(2, { title: "Quiet Slice" })] }, "POST /feedback": {} });
    mount();
    fireEvent.click((await screen.findAllByRole("button", { name: "Not for me: Quiet Slice" }))[0]);
    await waitFor(() => assert.ok(calls.some((c) => c.path === "/feedback")));
    assert.deepEqual(calls.find((c) => c.path === "/feedback")!.body, { id: 2, verdict: "disliked" });
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => assert.equal(calls.filter((c) => c.path === "/feedback").length, 2));
    assert.deepEqual(calls.filter((c) => c.path === "/feedback")[1].body, { id: 2, verdict: null });
  });

  test("a failed rating rolls the card back and says why", async () => {
    fakeApi({ "GET /picks": { picks: [pick(2, { title: "Quiet Slice" })] }, "POST /feedback": () => apiError(500, "disk full") });
    mount();
    fireEvent.click((await screen.findAllByRole("button", { name: "I'd like Quiet Slice" }))[0]);
    assert.ok((await screen.findAllByText("disk full")).length >= 1);
    await waitFor(() =>
      assert.equal(screen.getAllByRole("button", { name: "I'd like Quiet Slice" })[0].getAttribute("aria-pressed"), "false"),
    );
  });

  test("a show with no Sonarr route can be followed", async () => {
    const calls = fakeApi({ "GET /picks": { picks: [pick(5, { title: "Streamer", addVia: null })] }, "POST /picks/5/follow": {} });
    mount(status({ sonarr: false }));
    fireEvent.click((await screen.findAllByRole("button", { name: "Follow" }))[0]);
    await waitFor(() => assert.ok(calls.some((c) => c.path === "/picks/5/follow")));
    assert.ok((await screen.findAllByText("✓ Following")).length >= 1);
  });
});
