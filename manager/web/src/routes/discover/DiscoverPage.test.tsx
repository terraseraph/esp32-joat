import type { DiscoveryResult, DiscoveryState } from "@shared/api";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetApiForTests } from "../../api/testing";
import { getBrowserWs } from "../../api/ws";
import { FakeWebSocket } from "../../test/fakes";
import { DiscoverPage } from "../DiscoverPage";

function result(over: Partial<DiscoveryResult> & { id: string }): DiscoveryResult {
  return {
    host: "192.168.1.10",
    name: "esp32-aaaaaa",
    hostname: "esp32-aaaaaa",
    fw: "0.1.0",
    app_version: "9dcba89",
    via: "sweep",
    classification: "new",
    setup: false,
    netState: "sta_connected",
    lastSeen: "2026-11-10T09:00:00.000Z",
    ...over,
  };
}

const IDLE: DiscoveryState = {
  running: false,
  phase: "idle",
  probed: 0,
  total: 0,
  startedAt: null,
  finishedAt: null,
  warnings: [],
  subnets: [],
  results: [],
  ignored: [],
  networkScan: true,
};

const BENCH = result({ id: "c8f09e5a8821", name: "Bench test", hostname: "esp32-5a8821", host: "192.168.1.131" });
const NEW_B = result({ id: "c8f09e5a7710", name: "esp32-5a7710", hostname: "esp32-5a7710", host: "192.168.1.130", via: "mdns+sweep" });
const KITCHEN = result({
  id: "246f28c0ffee",
  name: "Kitchen relay",
  hostname: "esp32-c0ffee",
  host: "192.168.1.95",
  classification: "known",
  ipChanged: { from: "192.168.1.88", to: "192.168.1.95" },
});
const RECOVERY = result({ id: "30aea4123456", name: "esp32-123456", hostname: "esp32-123456", host: "192.168.1.140", setup: true, netState: "apsta_recovery" });

interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** Fetch stub keyed by "METHOD /path"; records every call. */
function stubServer(server: { state: DiscoveryState }) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = String(input).split("?")[0] ?? "";
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
    if (method === "GET" && path === "/api/discovery") return json(server.state);
    if (method === "POST" && path === "/api/discovery/scan") {
      server.state = { ...IDLE, running: true, phase: "mdns", startedAt: "2026-11-10T09:00:00.000Z" };
      return json(server.state, 202);
    }
    if (method === "POST" && path === "/api/discovery/adopt") {
      const ids = (body as { ids: string[] }).ids;
      server.state = { ...server.state, results: server.state.results.map((r) => (ids.includes(r.id) ? { ...r, classification: "known" as const } : r)) };
      return json({ added: ids.map((id) => ({ id, name: "Bench test", label: "", hostname: "esp32-5a8821" })), skipped: [] });
    }
    return json({ error: "Not found", code: "not_found" }, 404);
  });
  vi.stubGlobal("fetch", fn);
  return { calls, fn };
}

beforeEach(() => {
  resetApiForTests();
  FakeWebSocket.reset();
  vi.stubGlobal("WebSocket", FakeWebSocket);
});
afterEach(() => {
  resetApiForTests();
  vi.unstubAllGlobals();
});

function renderPage() {
  render(
    <MemoryRouter>
      <DiscoverPage />
    </MemoryRouter>,
  );
  getBrowserWs().connect();
  act(() => FakeWebSocket.last().open());
}

describe("DiscoverPage", () => {
  it("scans, shows live progress, groups the results and adopts through the server", async () => {
    const server = { state: IDLE };
    const { calls } = stubServer(server);
    renderPage();

    // never scanned
    expect(await screen.findByRole("heading", { name: "No scan yet" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Scan network/ }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/discovery/scan")).toBe(true));
    expect(calls.find((c) => c.path === "/api/discovery/scan")?.body).toEqual({ mdns: true, sweep: true });

    // sweep progress over the WebSocket
    const found = [BENCH, NEW_B, KITCHEN, RECOVERY];
    server.state = { ...server.state, phase: "sweep", probed: 120, total: 254, subnets: ["192.168.1.0/24"], results: found };
    act(() => FakeWebSocket.last().emit({ t: "scan", phase: "sweep", probed: 120, total: 254, found }));

    const bar = await screen.findByRole("progressbar", { name: "Scan progress" });
    expect(bar).toHaveAttribute("aria-valuenow", "120");
    expect(bar).toHaveAttribute("aria-valuemax", "254");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();

    // grouped, each group a headed section
    const newGroup = screen.getByRole("heading", { level: 2, name: "New" }).closest("section") as HTMLElement;
    expect(within(newGroup).getByText("Bench test")).toBeInTheDocument();
    expect(within(newGroup).getByText("esp32-5a7710")).toBeInTheDocument();
    expect(within(newGroup).getByRole("button", { name: "Add all (2)" })).toBeInTheDocument();
    const recovery = screen.getByRole("heading", { level: 2, name: "In setup / recovery" }).closest("section") as HTMLElement;
    expect(within(recovery).getByRole("button", { name: "Add esp32-123456" })).toBeInTheDocument();
    expect(within(recovery).getByText("Setup AP open")).toBeInTheDocument();
    const fleet = screen.getByRole("heading", { level: 2, name: "Already in fleet" }).closest("details") as HTMLElement;
    expect(within(fleet).getByText(/IP changed from/)).toBeInTheDocument();
    expect(within(fleet).getByRole("link", { name: "Open Kitchen relay" })).toHaveAttribute("href", "/devices/246f28c0ffee/live");

    // scan finishes
    server.state = { ...server.state, running: false, phase: "done", finishedAt: "2026-11-10T09:00:05.000Z" };
    act(() => FakeWebSocket.last().emit({ t: "scan", phase: "done", probed: 254, total: 254, found }));
    expect(await screen.findByText("Scan complete")).toBeInTheDocument();

    // Add one board
    fireEvent.click(within(newGroup).getByRole("button", { name: "Add Bench test" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/discovery/adopt")).toBe(true));
    expect(calls.find((c) => c.path === "/api/discovery/adopt")).toMatchObject({ method: "POST", body: { ids: ["c8f09e5a8821"] } });
    expect(await screen.findByText(/Added Bench test/)).toBeInTheDocument();
    // the server reclassified it: it is now listed under Already in fleet
    await waitFor(() => expect(within(screen.getByRole("heading", { name: "Already in fleet" }).closest("details") as HTMLElement).getByText("Bench test")).toBeInTheDocument());
  });

  it("attaches to a scan that is already running when the page opens", async () => {
    stubServer({ state: { ...IDLE, running: true, phase: "sweep", probed: 10, total: 100, subnets: ["10.0.0.0/24"], results: [] } });
    renderPage();
    const bar = await screen.findByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "10");
    expect(screen.getByText("10.0.0.0/24")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Scan network/ })).not.toBeInTheDocument();
  });

  it("shows the troubleshooting list when a finished scan found nothing", async () => {
    stubServer({ state: { ...IDLE, phase: "done", subnets: ["192.168.1.0/24"], finishedAt: "2026-11-10T09:00:05.000Z" } });
    renderPage();
    expect(await screen.findByRole("heading", { name: "No boards found" })).toBeInTheDocument();
    expect(screen.getByText(/Scanned 192\.168\.1\.0\/24/)).toBeInTheDocument();
  });

  it("adds by address with inline validation and plain error messages", async () => {
    const server = { state: { ...IDLE, phase: "done" as const } };
    const { calls, fn } = stubServer(server);
    renderPage();
    const input = await screen.findByLabelText("IP address or hostname");

    fireEvent.change(input, { target: { value: "192.168.1.999" } });
    fireEvent.blur(input);
    expect(await screen.findByText(/not a valid IPv4/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add device" }));
    expect(calls.some((c) => c.path === "/api/devices")).toBe(false);

    // server-side failure
    fn.mockImplementationOnce(async () => new Response(JSON.stringify({ error: "x", code: "captive_redirect" }), { status: 422 }));
    fireEvent.change(input, { target: { value: "192.168.1.60" } });
    fireEvent.click(screen.getByRole("button", { name: "Add device" }));
    expect(await screen.findByText(/redirects to 192\.168\.4\.1/)).toBeInTheDocument();

    // success (201) links to the device
    fn.mockImplementationOnce(
      async () => new Response(JSON.stringify({ id: "a4cf12b3c4d5", label: "", name: "Workshop node", hostname: "esp32-b3c4d5" }), { status: 201 }),
    );
    fireEvent.change(input, { target: { value: "192.168.1.42" } });
    fireEvent.click(screen.getByRole("button", { name: "Add device" }));
    expect(await screen.findByText("Added Workshop node")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open" })).toHaveAttribute("href", "/devices/a4cf12b3c4d5/live");
  });
});

describe("DiscoverPage when the Manager runs with --no-network-scan", () => {
  const OFF: DiscoveryState = { ...IDLE, networkScan: false };

  it("explains that scanning is off, disables mDNS and the sweep, and still scans the typed addresses", async () => {
    const server = { state: OFF };
    const { calls } = stubServer(server);
    renderPage();

    expect(await screen.findByText("Network scanning is turned off")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/--no-network-scan/);
    // the button says what it really does
    expect(screen.queryByRole("button", { name: /Scan network/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Advanced"));
    const mdns = screen.getByRole("checkbox", { name: "Use mDNS" });
    const sweep = screen.getByRole("checkbox", { name: "Sweep local networks" });
    expect(mdns).toBeDisabled();
    expect(mdns).not.toBeChecked();
    expect(sweep).toBeDisabled();
    expect(sweep).not.toBeChecked();
    expect(screen.getByText(/Off because this Manager was started with/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Also probe addresses"), { target: { value: "127.0.0.1:8101" } });
    fireEvent.click(screen.getByRole("button", { name: "Check addresses" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/discovery/scan")).toBe(true));
    expect(calls.find((c) => c.path === "/api/discovery/scan")?.body).toEqual({ mdns: false, sweep: false, targets: ["127.0.0.1:8101"] });
  });

  it("shows no notice when scanning is on", async () => {
    stubServer({ state: IDLE });
    renderPage();
    expect(await screen.findByRole("heading", { name: "No scan yet" })).toBeInTheDocument();
    expect(screen.queryByText("Network scanning is turned off")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Advanced"));
    expect(screen.getByRole("checkbox", { name: "Use mDNS" })).toBeEnabled();
  });
});
