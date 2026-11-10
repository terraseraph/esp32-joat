import type { AccessResponse, SettingsResponse } from "@shared/api";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetApiForTests } from "../api/testing";
import { setThemePref } from "../lib/theme";
import { HEALTH } from "../test/fakes";
import { renderWithProviders, routeFetch, type Call } from "./device/system/testkit";
import { SettingsPage } from "./SettingsPage";

const SETTINGS: SettingsResponse = {
  pollIntervalS: 30,
  discoveryTargets: ["192.168.20.7"],
  extraSubnets: [],
  backgroundScan: { enabled: false, periodMin: 5 },
  firmwareBaseUrl: "https://terraseraph.github.io/esp32-joat/",
  defaultParallelUpdates: 2,
};

const TOKEN = "s3cr3t-token-value";
const OFF: AccessResponse = {
  lan: false,
  host: "127.0.0.1",
  port: 5180,
  localUrl: "http://localhost:5180/",
  lanUrls: [],
  token: null,
  tokenMasked: null,
  tokenUrls: [],
  openUrl: null,
  remote: false,
  toggleAvailable: true,
  toggleUnavailableReason: null,
};
const ON: AccessResponse = {
  ...OFF,
  lan: true,
  host: "0.0.0.0",
  lanUrls: ["http://192.168.1.5:5180/"],
  token: TOKEN,
  tokenMasked: "••••••••••••alue",
  tokenUrls: [`http://192.168.1.5:5180/?token=${TOKEN}`],
  openUrl: `http://192.168.1.5:5180/?token=${TOKEN}`,
};
const HEALTH_FULL = { ...HEALTH, startedAt: Date.UTC(2026, 10, 10, 8, 30), version: "0.1.0" };

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetApiForTests();
  localStorage.clear();
  setThemePref("system");
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});
afterEach(() => {
  resetApiForTests();
  vi.unstubAllGlobals();
});

function setup(access: AccessResponse = OFF, extra: Parameters<typeof routeFetch>[0] = {}): Call[] {
  return routeFetch({
    "GET /api/health": { body: HEALTH_FULL },
    "GET /api/settings": { body: SETTINGS },
    "GET /api/access": { body: access },
    ...extra,
  });
}

const putCalls = (calls: Call[], path: string) => calls.filter((c) => c.method !== "GET" && c.path === path);

describe("loading", () => {
  it("shows every section with the loaded values, the data folder, version and installer link", async () => {
    setup();
    renderWithProviders(<SettingsPage />);
    expect(screen.getByLabelText("Loading devices and discovery")).toBeInTheDocument();
    expect(await screen.findByLabelText("Check devices every")).toHaveValue(30);
    for (const h of ["Devices and discovery", "Firmware", "Appearance", "LAN access", "Data folder", "About"]) {
      expect(screen.getByRole("heading", { level: 2, name: h })).toBeInTheDocument();
    }
    expect(screen.getByText("192.168.20.7")).toBeInTheDocument();
    expect(screen.getByLabelText("Firmware source")).toHaveValue("https://terraseraph.github.io/esp32-joat/");
    expect(await screen.findByTestId("data-dir")).toHaveTextContent("C:\\data");
    expect(screen.getByText("de-esp32 Manager 0.1.0")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Browser installer/ })).toHaveAttribute("href", "https://terraseraph.github.io/esp32-joat/");
  });

  it("shows the server error with Retry when settings cannot be loaded", async () => {
    let fail = true;
    setup(OFF, { "GET /api/settings": () => (fail ? { status: 500, body: { error: "Settings file unreadable", code: "internal_error" } } : { body: SETTINGS }) });
    renderWithProviders(<SettingsPage />);
    expect(await screen.findByText("Settings file unreadable")).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByLabelText("Check devices every")).toBeInTheDocument();
  });
});

describe("saving", () => {
  it("saves only what changed, with a toast, and disables Save again afterwards", async () => {
    const calls = setup(OFF, {
      "PUT /api/settings": (c) => ({ body: { ...SETTINGS, ...(c.body as object) } }),
    });
    renderWithProviders(<SettingsPage />);
    const poll = await screen.findByLabelText("Check devices every");
    const devices = screen.getByRole("heading", { name: "Devices and discovery" }).closest("section") as HTMLElement;
    const save = within(devices).getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    fireEvent.change(poll, { target: { value: "60" } });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    expect(await screen.findByText("Device settings saved")).toBeInTheDocument();
    expect(putCalls(calls, "/api/settings")).toEqual([{ method: "PUT", path: "/api/settings", body: { pollIntervalS: 60 } }]);
    await waitFor(() => expect(within(devices).getByRole("button", { name: "Save" })).toBeDisabled());
    expect(screen.getByLabelText("Check devices every")).toHaveValue(60);
  });

  it("saves background scan, extra targets and subnets together", async () => {
    const calls = setup(OFF, { "PUT /api/settings": (c) => ({ body: { ...SETTINGS, ...(c.body as object) } }) });
    renderWithProviders(<SettingsPage />);
    await screen.findByLabelText("Check devices every");
    fireEvent.click(screen.getByRole("switch", { name: /Scan in the background/ }));
    fireEvent.change(screen.getByLabelText("Scan every"), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("Extra discovery targets"), { target: { value: "192.168.30.2:8080" } });
    fireEvent.click(screen.getByRole("button", { name: "Add to Extra discovery targets" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove 192.168.20.7" }));
    fireEvent.change(screen.getByLabelText("Extra subnets to sweep"), { target: { value: "192.168.40.0/24" } });
    fireEvent.keyDown(screen.getByLabelText("Extra subnets to sweep"), { key: "Enter" });
    const devices = screen.getByRole("heading", { name: "Devices and discovery" }).closest("section") as HTMLElement;
    fireEvent.click(within(devices).getByRole("button", { name: "Save" }));
    await screen.findByText("Device settings saved");
    expect(putCalls(calls, "/api/settings")[0]?.body).toEqual({
      backgroundScan: { enabled: true, periodMin: 10 },
      discoveryTargets: ["192.168.30.2:8080"],
      extraSubnets: ["192.168.40.0/24"],
    });
  });

  it("shows the server's validation error verbatim, on the entry too, and keeps the draft", async () => {
    setup(OFF, {
      "PUT /api/settings": {
        status: 400,
        body: { error: "Invalid discoveryTargets: not a host: bad host", code: "invalid_body", details: [{ path: "/discoveryTargets/1", message: "not a host: bad host" }] },
      },
    });
    renderWithProviders(<SettingsPage />);
    await screen.findByLabelText("Check devices every");
    fireEvent.change(screen.getByLabelText("Extra discovery targets"), { target: { value: "bad host" } });
    fireEvent.click(screen.getByRole("button", { name: "Add to Extra discovery targets" }));
    const devices = screen.getByRole("heading", { name: "Devices and discovery" }).closest("section") as HTMLElement;
    fireEvent.click(within(devices).getByRole("button", { name: "Save" }));
    expect(await within(devices).findByText("Invalid discoveryTargets: not a host: bad host")).toBeInTheDocument();
    const entry = screen.getByText("bad host").closest("li") as HTMLElement;
    expect(within(entry).getByRole("alert")).toHaveTextContent("not a host: bad host");
    expect(screen.queryByText("Device settings saved")).not.toBeInTheDocument();
    expect(within(devices).getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("refuses an out-of-range poll interval before asking the server", async () => {
    const calls = setup();
    renderWithProviders(<SettingsPage />);
    const poll = await screen.findByLabelText("Check devices every");
    fireEvent.change(poll, { target: { value: "5" } });
    expect(await screen.findByText("Use 10 to 300 seconds.")).toBeInTheDocument();
    const devices = screen.getByRole("heading", { name: "Devices and discovery" }).closest("section") as HTMLElement;
    expect(within(devices).getByRole("button", { name: "Save" })).toBeDisabled();
    expect(putCalls(calls, "/api/settings")).toHaveLength(0);
  });

  it("saves the firmware source and default parallel updates; Reset to default restores the address", async () => {
    const calls = setup(OFF, { "PUT /api/settings": (c) => ({ body: { ...SETTINGS, ...(c.body as object) } }) });
    renderWithProviders(<SettingsPage />);
    const url = await screen.findByLabelText("Firmware source");
    fireEvent.change(url, { target: { value: "https://example.org/fw/" } });
    fireEvent.click(screen.getByRole("radio", { name: "4" }));
    const fw = screen.getByRole("heading", { name: "Firmware" }).closest("section") as HTMLElement;
    fireEvent.click(within(fw).getByRole("button", { name: "Save" }));
    await screen.findByText("Firmware settings saved");
    expect(putCalls(calls, "/api/settings")[0]?.body).toEqual({ firmwareBaseUrl: "https://example.org/fw/", defaultParallelUpdates: 4 });
    fireEvent.click(within(fw).getByRole("button", { name: "Reset to default" }));
    expect(screen.getByLabelText("Firmware source")).toHaveValue("https://terraseraph.github.io/esp32-joat/");
  });
});

describe("appearance", () => {
  it("changes the theme and follows the shared state", async () => {
    setup();
    renderWithProviders(<SettingsPage />);
    await screen.findByLabelText("Check devices every");
    expect(screen.getByRole("radio", { name: "System" })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(screen.getByRole("radio", { name: "Dark" })).toBeChecked();
    act(() => setThemePref("light"));
    expect(screen.getByRole("radio", { name: "Light" })).toBeChecked();
  });
});

describe("LAN access", () => {
  it("always shows the plain warning, and explains that LAN is off", async () => {
    setup(OFF);
    renderWithProviders(<SettingsPage />);
    expect(await screen.findByText("This PC only")).toBeInTheDocument();
    expect(screen.getByText(/Anyone with the access token can control every device/)).toBeInTheDocument();
    expect(screen.getByText(/have no password of their own/)).toBeInTheDocument();
    expect(screen.getByText("LAN access is off. Only this PC can open the Manager.")).toBeInTheDocument();
    expect(screen.queryByText("Access token")).not.toBeInTheDocument();
  });

  it("switches LAN on and shows the addresses, the masked token and the link; switches it off again", async () => {
    let state = OFF;
    const calls = setup(OFF, {
      "GET /api/access": () => ({ body: state }),
      "PUT /api/access": (c) => {
        state = (c.body as { enabled: boolean }).enabled ? ON : OFF;
        return { body: state };
      },
    });
    renderWithProviders(<SettingsPage />);
    const sw = await screen.findByRole("switch", { name: /Let other devices on my network open the Manager/ });
    expect(sw).not.toBeChecked();
    fireEvent.click(sw);
    expect(await screen.findByText("LAN access is on. Other devices need the access token.")).toBeInTheDocument();
    expect(putCalls(calls, "/api/access")[0]?.body).toEqual({ enabled: true });
    expect(await screen.findByText("LAN access on")).toBeInTheDocument();
    expect(screen.getByText("http://192.168.1.5:5180/")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(TOKEN);
    expect(screen.getByTestId("open-url")).toHaveTextContent("http://192.168.1.5:5180/?token=••••••••••••");
    // The nav badge reads /api/health: the page asks again after a switch.
    expect(calls.filter((c) => c.path === "/api/health").length).toBeGreaterThanOrEqual(2);

    fireEvent.click(screen.getByRole("switch", { name: /Let other devices on my network open the Manager/ }));
    expect(await screen.findByText("LAN access is off. Only this PC can open the Manager.")).toBeInTheDocument();
    expect(putCalls(calls, "/api/access").map((c) => c.body)).toEqual([{ enabled: true }, { enabled: false }]);
    expect(await screen.findByText("LAN access is off")).toBeInTheDocument(); // toast
  });

  it("shows why the switch failed, verbatim, and stays off", async () => {
    setup(OFF, { "PUT /api/access": { status: 409, body: { error: "Could not listen on 0.0.0.0:5180 (EADDRINUSE). The Manager keeps listening on 127.0.0.1.", code: "rebind_failed" } } });
    renderWithProviders(<SettingsPage />);
    fireEvent.click(await screen.findByRole("switch", { name: /Let other devices/ }));
    expect(await screen.findByText(/EADDRINUSE/)).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /Let other devices/ })).not.toBeChecked();
  });

  it("reveals and copies the token and the link (the whole link, not the masked one)", async () => {
    setup(ON);
    renderWithProviders(<SettingsPage />);
    expect(await screen.findByText("http://192.168.1.5:5180/")).toBeInTheDocument();
    expect(screen.getByTestId("token")).toHaveTextContent("••••••••••••alue");
    expect(document.body.textContent).not.toContain(TOKEN);

    fireEvent.click(screen.getByRole("button", { name: "Reveal token" }));
    expect(screen.getByTestId("token")).toHaveTextContent(TOKEN);
    expect(screen.getByTestId("open-url")).toHaveTextContent(`?token=${TOKEN}`);
    fireEvent.click(screen.getByRole("button", { name: "Hide token" }));
    expect(document.body.textContent).not.toContain(TOKEN);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy token" }));
    });
    expect(writeText).toHaveBeenLastCalledWith(TOKEN);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy link with token" }));
    });
    expect(writeText).toHaveBeenLastCalledWith(`http://192.168.1.5:5180/?token=${TOKEN}`);
    expect(await screen.findAllByText("Copied")).not.toHaveLength(0);
  });

  it("regenerating the token asks first, explains who loses access, then shows the new token", async () => {
    const NEW = { ...ON, token: "brand-new-token-value", tokenMasked: "••••••••••••alue", openUrl: "http://192.168.1.5:5180/?token=brand-new-token-value", tokenUrls: ["http://192.168.1.5:5180/?token=brand-new-token-value"] };
    const calls = setup(ON, { "POST /api/access/token": { body: NEW } });
    renderWithProviders(<SettingsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Regenerate token" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Every other browser or phone that uses the current link/)).toBeInTheDocument();
    expect(putCalls(calls, "/api/access/token")).toHaveLength(0);

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(putCalls(calls, "/api/access/token")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Regenerate token" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Regenerate token" }));
    expect(await screen.findByText("Access token regenerated")).toBeInTheDocument();
    expect(putCalls(calls, "/api/access/token")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Reveal token" }));
    expect(screen.getByTestId("token")).toHaveTextContent("brand-new-token-value");
  });

  it("a remote user must confirm switching off, and is told they were disconnected", async () => {
    const REMOTE = { ...ON, remote: true };
    const calls = setup(REMOTE, { "PUT /api/access": { body: { ...OFF, remote: true } } });
    renderWithProviders(<SettingsPage />);
    fireEvent.click(await screen.findByRole("switch", { name: /Let other devices/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/You are using the Manager from another device/)).toBeInTheDocument();
    expect(putCalls(calls, "/api/access")).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Switch off" }));
    expect(await screen.findByText("LAN access is off and this device is disconnected")).toBeInTheDocument();
    expect(putCalls(calls, "/api/access")[0]?.body).toEqual({ enabled: false });
  });

  it("shows the not-available state (desktop app or fixed --host) with the reason and no working switch", async () => {
    setup({ ...OFF, toggleAvailable: false, toggleUnavailableReason: "LAN access is not available in the desktop app." });
    renderWithProviders(<SettingsPage />);
    const sw = await screen.findByRole("switch", { name: /Let other devices/ });
    expect(sw).toBeDisabled();
    expect(screen.getByText("Not available here")).toBeInTheDocument();
    expect(screen.getByText("LAN access is not available in the desktop app.")).toBeInTheDocument();
  });

  it("shows the access error with Retry when /api/access fails", async () => {
    setup(OFF, { "GET /api/access": { status: 401, body: { error: "Access token required", code: "unauthorized" } } });
    renderWithProviders(<SettingsPage />);
    expect(await screen.findByText("Access token required")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Retry" }).length).toBeGreaterThan(0);
  });
});
