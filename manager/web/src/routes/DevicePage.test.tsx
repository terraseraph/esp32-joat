import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetApiForTests } from "../api/testing";
import { getBrowserWs } from "../api/ws";
import { deviceBannerKeys } from "../components/device/DeviceBanners";
import { FakeWebSocket } from "../test/fakes";
import { makeStatus, makeSummary, renderWithProviders, routeFetch } from "./device/system/testkit";
import { DevicePage } from "./DevicePage";

const ID = "a4cf12b3c4d5";
const BASE = `/api/devices/${ID}`;

beforeEach(() => {
  resetApiForTests();
  FakeWebSocket.reset();
  vi.stubGlobal("WebSocket", FakeWebSocket);
});
afterEach(() => {
  resetApiForTests();
  vi.unstubAllGlobals();
});

function page(route: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/devices/:id/*" element={<DevicePage />} />
      <Route path="/" element={<div>fleet home</div>} />
    </Routes>,
    route,
  );
}

describe("deviceBannerKeys", () => {
  it("lists the banners that apply, in order", () => {
    expect(deviceBannerKeys({ health: "online", safe_mode: false, attention: [] })).toEqual([]);
    expect(deviceBannerKeys({ health: "unreachable", safe_mode: null, attention: [] })).toEqual(["offline"]);
    expect(deviceBannerKeys({ health: "rebooting", safe_mode: null, attention: [] })).toEqual(["rebooting"]);
    expect(deviceBannerKeys({ health: "online", safe_mode: true, attention: ["safe_mode", "host_mismatch"] })).toEqual(["safe", "mismatch"]);
  });
});

describe("DevicePage shell", () => {
  it("shows header chips and actions for an online device", async () => {
    routeFetch({ "GET /api/devices": { body: [makeSummary({ attention: ["mqtt_disconnected"], queue: 2 })] }, [`GET ${BASE}/v1/status`]: { body: makeStatus() } });
    page(`/devices/${ID}/system`);
    expect(await screen.findByRole("heading", { level: 1, name: "Workshop node" })).toBeInTheDocument();
    expect(screen.getByText("Online")).toBeInTheDocument();
    expect(screen.getByText("Needs attention")).toBeInTheDocument();
    expect(screen.getByText("Busy")).toBeInTheDocument();
    expect(screen.getAllByText("9dcba89").length).toBeGreaterThan(0);
    expect(document.title).toBe("Workshop node · de-esp32 Manager");
    const link = screen.getAllByRole("link", { name: /Open device page/ })[0]!;
    expect(link).toHaveAttribute("href", "http://192.168.1.42/");
    expect(link).toHaveAttribute("target", "_blank");
    expect(screen.getAllByRole("button", { name: /Update/ })[0]).toBeEnabled();
    expect(screen.getAllByRole("button", { name: /Back up/ })[0]).toBeEnabled();
  });

  it("shows a warn banner when offline and Retry refreshes the device", async () => {
    const calls = routeFetch({
      "GET /api/devices": { body: [makeSummary({ health: "offline", lastSeen: new Date(Date.now() - 5 * 60_000).toISOString() })] },
      [`POST ${BASE}/refresh`]: { body: makeSummary({ health: "online" }) },
    });
    page(`/devices/${ID}/system`);
    expect(await screen.findByText(/Can't reach this device\. Last seen 5 min ago\./)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Retry" })[0]!);
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === `${BASE}/refresh`)).toBe(true));
    await waitFor(() => expect(screen.queryByText(/Can't reach this device/)).toBeNull());
  });

  it("shows the safe mode banner with the reason", async () => {
    routeFetch({ "GET /api/devices": { body: [makeSummary({ safe_mode: true, safe_reason: "pin conflict", attention: ["safe_mode"] })] } });
    page(`/devices/${ID}/live`);
    expect(await screen.findByText("Safe mode: the I/O configuration was not applied")).toBeInTheDocument();
    expect(screen.getByText("pin conflict")).toBeInTheDocument();
  });

  it("shows the restarting banner", async () => {
    routeFetch({ "GET /api/devices": { body: [makeSummary({ health: "rebooting" })] } });
    page(`/devices/${ID}/live`);
    expect(await screen.findByText(/Restarting… waiting for Workshop node to come back/)).toBeInTheDocument();
  });

  it("shows the empty state for an unknown device and links back to the Fleet", async () => {
    routeFetch({ "GET /api/devices": { body: [] } });
    page(`/devices/nope/live`);
    expect(await screen.findByText("This device is not in your fleet")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "Back to Fleet" }));
    expect(await screen.findByText("fleet home")).toBeInTheDocument();
  });

  it("confirms before rebooting and sends system.reboot", async () => {
    const calls = routeFetch({
      "GET /api/devices": { body: [makeSummary()] },
      [`POST ${BASE}/command`]: { body: { v: 1, ok: true, result: { expectedRestart: true } } },
    });
    page(`/devices/${ID}/live`);
    await screen.findByRole("heading", { level: 1, name: "Workshop node" });
    fireEvent.click(screen.getAllByRole("button", { name: "Reboot" })[0]!);
    expect(await screen.findByText("Reboot Workshop node?")).toBeInTheDocument();
    const reboots = () => calls.filter((c) => (c.body as { cmd?: string } | undefined)?.cmd === "system.reboot");
    expect(reboots()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Reboot" }));
    await waitFor(() => expect(reboots().map((c) => c.body)).toEqual([{ cmd: "system.reboot" }]));
    expect(await screen.findByText("Restarting Workshop node…")).toBeInTheDocument();
  });
  it("does not remount the tab or close a dialog when the device comes back from a restart, its summary changes, or the socket reconnects", async () => {
    const calls = routeFetch({ "GET /api/devices": { body: [makeSummary()] }, [`GET ${BASE}/v1/status`]: { body: makeStatus() } });
    page(`/devices/${ID}/system`);
    await screen.findByRole("heading", { level: 1, name: "Workshop node" });
    const region = await screen.findByRole("region", { name: "System" });
    await waitFor(() => expect(region.firstElementChild).not.toBeNull());
    const content = region.firstElementChild;
    const statusReads = () => calls.filter((c) => c.method === "GET" && c.path === `${BASE}/v1/status`).length;
    const before = statusReads();

    fireEvent.click(screen.getAllByRole("button", { name: "Reboot" })[0]!);
    expect(await screen.findByText("Reboot Workshop node?")).toBeInTheDocument();

    getBrowserWs().connect();
    const ws = FakeWebSocket.last();
    act(() => ws.open());
    act(() => ws.emit({ t: "device", id: ID, summary: makeSummary({ health: "rebooting" }) }));
    act(() => ws.emit({ t: "device", id: ID, summary: makeSummary({ health: "online" }) }));
    expect(await screen.findByText("Workshop node is back online")).toBeInTheDocument();
    act(() => ws.emit({ t: "device", id: ID, summary: makeSummary({ health: "online", queue: 2 }) }));
    act(() => ws.serverClose());
    act(() => ws.emit({ t: "devices", list: [makeSummary({ health: "online", queue: 0 })] }));

    expect(screen.getByText("Reboot Workshop node?")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "System", hidden: true })).toBe(region);
    expect(region.isConnected).toBe(true);
    expect(region.firstElementChild).toBe(content);
    // the tab re-read its data in place
    await waitFor(() => expect(statusReads()).toBeGreaterThan(before));
    expect(region.firstElementChild).toBe(content);
  });
});
