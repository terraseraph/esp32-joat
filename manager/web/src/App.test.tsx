import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { resetApiForTests } from "./api/testing";
import { setThemePref } from "./lib/theme";
import { FakeWebSocket, HEALTH, mockFetch } from "./test/fakes";
import { makeSummary } from "./routes/device/system/testkit";

function renderApp(path = "/") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  resetApiForTests();
  FakeWebSocket.reset();
  vi.stubGlobal("WebSocket", FakeWebSocket);
  localStorage.clear();
  setThemePref("system");
  mockFetch({ "/api/health": { body: HEALTH } });
});
afterEach(() => {
  resetApiForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("navigation", () => {
  it("renders the five nav items and follows the route", async () => {
    renderApp("/");
    const nav = screen.getByRole("navigation", { name: "Main" });
    const names = within(nav)
      .getAllByRole("link")
      .map((a) => a.getAttribute("aria-label"));
    expect(names).toEqual(["Fleet", "Discover", "Firmware", "Backups", "Settings"]);
    expect(within(nav).getByRole("link", { name: "Fleet" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "Discover" })).not.toHaveAttribute("aria-current");

    fireEvent.click(within(nav).getByRole("link", { name: "Discover" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Discover" })).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: "Discover" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "Fleet" })).not.toHaveAttribute("aria-current");
  });

  it("has a skip link to the main region", () => {
    renderApp("/firmware");
    expect(screen.getByRole("link", { name: "Skip to content" })).toHaveAttribute("href", "#main");
    expect(screen.getByRole("main")).toHaveAttribute("id", "main");
  });

  it("shows a 404 page for unknown routes", async () => {
    renderApp("/nope/at/all");
    expect(await screen.findByRole("heading", { level: 1, name: "Page not found" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to Fleet" })).toHaveAttribute("href", "/");
  });
});

describe("device route", () => {
  beforeEach(() => {
    mockFetch({ "/api/health": { body: HEALTH }, "/api/devices": { body: [makeSummary({ id: "abc", name: "Bench", hostname: "esp32-abc" })] } });
  });

  it("redirects /devices/:id to the Live tab and shows the four tabs", async () => {
    renderApp("/devices/abc");
    const tabs = await screen.findByRole("navigation", { name: "Device sections" });
    const links = within(tabs).getAllByRole("link");
    expect(links.map((a) => a.textContent)).toEqual(["Live", "Pins & add-ons", "Network", "System"]);
    expect(within(tabs).getByRole("link", { name: "Live" })).toHaveAttribute("aria-current", "page");
    expect(within(tabs).getByRole("link", { name: "Live" })).toHaveAttribute("href", "/devices/abc/live");
    expect(screen.getByRole("heading", { level: 1, name: "Bench" })).toBeInTheDocument();
    // device pages belong to Fleet in the side nav
    expect(within(screen.getByRole("navigation", { name: "Main" })).getByRole("link", { name: "Fleet" })).toHaveAttribute("aria-current", "page");
  });

  it("switches tab content", async () => {
    renderApp("/devices/abc/live");
    await screen.findByRole("region", { name: "Live" });
    const tabs = screen.getByRole("navigation", { name: "Device sections" });
    fireEvent.click(within(tabs).getByRole("link", { name: "Network" }));
    expect(await screen.findByRole("region", { name: "Network" })).toBeInTheDocument();
    expect(within(tabs).getByRole("link", { name: "Network" })).toHaveAttribute("aria-current", "page");
  });

  it("falls back to Live for an unknown tab", async () => {
    renderApp("/devices/abc/bogus");
    expect(await screen.findByRole("region", { name: "Live" })).toBeInTheDocument();
  });

  it("offers the actions inline and in a More menu", async () => {
    renderApp("/devices/abc/live");
    const group = await screen.findByRole("group", { name: "Device actions" });
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual(["Refresh", "Back up", "Update", "Reboot"]);
    expect(within(group).getByRole("link", { name: "Open device page" })).toHaveAttribute("href", "http://192.168.1.42/");
    expect(within(group).getByRole("button", { name: "Update" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "More actions" })).toBeInTheDocument();
  });
});

describe("theme toggle", () => {
  it("cycles System, Light, Dark, sets data-theme and persists", () => {
    renderApp("/");
    const root = document.documentElement;
    expect(root).not.toHaveAttribute("data-theme");

    fireEvent.click(screen.getByRole("button", { name: /^Theme: System/ }));
    expect(root).toHaveAttribute("data-theme", "light");
    expect(localStorage.getItem("deesp32-theme")).toBe("light");

    fireEvent.click(screen.getByRole("button", { name: /^Theme: Light/ }));
    expect(root).toHaveAttribute("data-theme", "dark");
    expect(localStorage.getItem("deesp32-theme")).toBe("dark");

    fireEvent.click(screen.getByRole("button", { name: /^Theme: Dark/ }));
    expect(root).not.toHaveAttribute("data-theme");
    expect(localStorage.getItem("deesp32-theme")).toBeNull();
  });

  it("still works when localStorage throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    renderApp("/");
    fireEvent.click(screen.getByRole("button", { name: /^Theme: System/ }));
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
  });
});

describe("server indicator", () => {
  it("goes connecting, connected (health ok + WS open), then offline when the WS closes", async () => {
    renderApp("/");
    expect(await screen.findByText("Connecting…")).toBeInTheDocument();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.last().url).toMatch(/^ws:\/\/.+\/api\/ws$/);

    act(() => FakeWebSocket.last().open());
    expect(await screen.findByText("Server connected")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Server connected" })).toHaveAttribute("data-connection", "connected");

    act(() => FakeWebSocket.last().serverClose());
    expect(await screen.findByText("Server offline")).toBeInTheDocument();
  });

  it("shows offline when /api/health fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("down")));
    renderApp("/");
    act(() => FakeWebSocket.last().open());
    expect(await screen.findByText("Server offline")).toBeInTheDocument();
  });

  it("shows a LAN badge when the server runs with --lan", async () => {
    mockFetch({ "/api/health": { body: { ...HEALTH, lan: true } } });
    renderApp("/");
    expect(await screen.findByText("LAN")).toBeInTheDocument();
  });

  it("does not show the LAN badge otherwise", async () => {
    renderApp("/");
    act(() => FakeWebSocket.last().open());
    await screen.findByText("Server connected");
    expect(screen.queryByText("LAN")).not.toBeInTheDocument();
  });
});

describe("settings page", () => {
  it("renders the Settings screen at /settings (details are covered in routes/SettingsPage.test.tsx)", async () => {
    mockFetch({ "/api/health": { body: HEALTH }, "/api/settings": { body: { pollIntervalS: 30, discoveryTargets: [], extraSubnets: [], backgroundScan: { enabled: false, periodMin: 5 }, firmwareBaseUrl: "https://example.org/", defaultParallelUpdates: 2 } }, "/api/access": { body: { lan: false, host: "127.0.0.1", port: 5180, localUrl: "http://localhost:5180/", lanUrls: [], token: null, tokenMasked: null, tokenUrls: [], openUrl: null, remote: false, toggleAvailable: true, toggleUnavailableReason: null } } });
    renderApp("/settings");
    expect(await screen.findByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
    expect(await screen.findByText("This PC only")).toBeInTheDocument();
  });

  it("re-reads the LAN state when the server announces a switch", async () => {
    let lan = false;
    const fn = mockFetch({ "/api/health": () => ({ body: { ...HEALTH, lan } }) });
    renderApp("/");
    act(() => FakeWebSocket.last().open());
    await screen.findByText("Server connected");
    expect(screen.queryByText("LAN")).not.toBeInTheDocument();
    lan = true;
    act(() => FakeWebSocket.last().emit({ t: "access", lan: true }));
    expect(await screen.findByText("LAN")).toBeInTheDocument();
    expect(fn).toHaveBeenCalled();
  });
});
