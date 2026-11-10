import type { DeviceSummary } from "@shared/api";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetApiForTests } from "../../api/testing";
import { ConfirmProvider, ToastProvider, TooltipProvider } from "../../components/ui";
import { FakeWebSocket } from "../../test/fakes";
import { FleetPage } from "../FleetPage";
import { makeDevice } from "./fixtures";
import { PREFS_KEY } from "./logic";

interface Call {
  method: string;
  path: string;
  body: unknown;
}

function stubServer(devices: DeviceSummary[]) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = String(input).split("?")[0] ?? "";
      const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method, path, body });
      const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
      if (method === "GET" && path === "/api/devices") return json(devices);
      if (method === "POST" && path.endsWith("/command")) return json({ v: 1, ok: true, result: { expectedRestart: true } });
      return json({ error: "Not found", code: "not_found" }, 404);
    }),
  );
  return calls;
}

const WORKSHOP = makeDevice({ id: "a4cf12b3c4d5", name: "Workshop node", host: "192.168.1.42", module_count: 2, io_count: 7 });
const GREENHOUSE = makeDevice({ id: "a4cf12e81f20", name: "Greenhouse", host: "192.168.1.57" });
const KITCHEN = makeDevice({ id: "246f28c0ffee", name: "Kitchen relay", host: "192.168.1.88", health: "offline", lastSeen: "2026-11-10T08:00:00.000Z" });
const GARAGE = makeDevice({ id: "3c71bf0a9e11", name: "Garage door", host: "192.168.1.63", attention: ["mqtt_disconnected"], mqtt: { configured: true, connected: false } });

function renderPage() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <ToastProvider>
          <ConfirmProvider>
            <FleetPage />
          </ConfirmProvider>
        </ToastProvider>
      </TooltipProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  resetApiForTests();
  FakeWebSocket.reset();
  vi.stubGlobal("WebSocket", FakeWebSocket);
  localStorage.clear();
});
afterEach(() => {
  resetApiForTests();
  vi.unstubAllGlobals();
});

describe("FleetPage", () => {
  it("lists the fleet, switches to the table, bulk-reboots two devices and remembers the view", async () => {
    const calls = stubServer([WORKSHOP, GREENHOUSE, KITCHEN, GARAGE]);
    renderPage();

    expect(await screen.findByRole("heading", { level: 3, name: "Workshop node" })).toBeInTheDocument();
    const strip = screen.getByRole("region", { name: "Fleet summary" });
    expect(within(strip).getByText("including 1 that needs attention")).toBeInTheDocument();
    expect(within(strip).getByRole("button", { name: /Firmware differs/ })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText(/^Last seen /)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();

    // cards -> table
    fireEvent.click(screen.getByRole("button", { name: "Table" }));
    const table = await screen.findByRole("table");
    expect(within(table).getByText("Garage door")).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}")).toMatchObject({ view: "table" });

    // select two, the bulk bar appears
    expect(screen.queryByRole("region", { name: "Bulk actions" })).not.toBeInTheDocument();
    fireEvent.click(within(table).getByRole("checkbox", { name: "Select Workshop node" }));
    fireEvent.click(within(table).getByRole("checkbox", { name: "Select Greenhouse" }));
    const bar = await screen.findByRole("region", { name: "Bulk actions" });
    expect(within(bar).getByText("2 selected")).toBeInTheDocument();
    expect(within(bar).getByRole("button", { name: "Update firmware…" })).toBeEnabled();
    expect(within(bar).getByRole("button", { name: "Back up" })).toBeEnabled();

    // reboot: confirm, then one system.reboot per device
    fireEvent.click(within(bar).getByRole("button", { name: "Reboot" }));
    expect(await screen.findByText("Reboot 2 devices?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reboot 2" }));
    await waitFor(() => expect(calls.filter((c) => c.path.endsWith("/command"))).toHaveLength(2));
    const cmds = calls.filter((c) => c.path.endsWith("/command"));
    expect(cmds.map((c) => c.path).sort()).toEqual(["/api/devices/a4cf12b3c4d5/command", "/api/devices/a4cf12e81f20/command"]);
    expect(cmds.every((c) => c.method === "POST" && JSON.stringify(c.body) === JSON.stringify({ cmd: "system.reboot" }))).toBe(true);
    expect(await screen.findByText("Restarting 2 devices")).toBeInTheDocument();
  });

  it("filters from the summary strip, searches, and offers a way out when nothing matches", async () => {
    stubServer([WORKSHOP, GREENHOUSE, KITCHEN, GARAGE]);
    renderPage();
    await screen.findByRole("heading", { level: 3, name: "Workshop node" });

    fireEvent.click(within(screen.getByRole("region", { name: "Fleet summary" })).getByRole("button", { name: /Offline \/ unreachable/ }));
    await waitFor(() => expect(screen.queryByRole("heading", { level: 3, name: "Workshop node" })).not.toBeInTheDocument());
    expect(screen.getByRole("heading", { level: 3, name: "Kitchen relay" })).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: /Search/ }), { target: { value: "zzz" } });
    expect(await screen.findByRole("heading", { name: "No devices match" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear search and filters" }));
    expect(await screen.findByRole("heading", { level: 3, name: "Workshop node" })).toBeInTheDocument();
  });

  it("shows the empty fleet with the installer link", async () => {
    stubServer([]);
    renderPage();
    expect(await screen.findByRole("heading", { name: "No devices yet" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /browser installer/ })).toHaveAttribute("href", "https://terraseraph.github.io/esp32-joat/");
  });

  it("warns when no device can be reached", async () => {
    stubServer([KITCHEN, makeDevice({ id: "08b61f22c4e7", name: "Desk lamp", health: "unreachable" })]);
    renderPage();
    expect(await screen.findByText("Can't reach any device")).toBeInTheDocument();
  });
});
