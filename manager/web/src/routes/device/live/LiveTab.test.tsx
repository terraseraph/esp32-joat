import type { DeviceSummary } from "@shared/api";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDevices } from "../../../api/devices";
import { resetApiForTests } from "../../../api/testing";
import { getBrowserWs } from "../../../api/ws";
import { ToastProvider } from "../../../components/ui";
import { FakeWebSocket } from "../../../test/fakes";
import { LiveTab } from "./LiveTab";

const ID = "a4cf12b3c4d5";

function summary(over: Partial<DeviceSummary> = {}): DeviceSummary {
  return {
    id: ID, name: "Workshop node", label: "", notes: "", hostname: "esp32-b3c4d5", host: "10.0.0.5", addedAt: "2026-01-01T00:00:00Z",
    addedVia: "manual", health: "online", attention: [], lastSeen: null, fw: null, app_version: null, compile_date: null,
    fwMatchesTarget: null, uptime_s: null, boot_state: null, safe_mode: false, safe_reason: null, rssi: -58, net_state: null,
    mqtt: { configured: true, connected: true }, memory: { pressure: "ok", free: null, total: null },
    ota: { running_partition: null, image_state: null, rollback_possible: null, busy: null },
    io_count: null, module_count: null, link: "closed", queue: 0, ...over,
  };
}

const IO = {
  gpio_4: { id: "gpio_4", mode: "out", gpio: 4, level: 0 },
  adc_34: { id: "adc_34", mode: "adc", gpio: 34, mv: 1650, raw: 2048, sample_ms: 50, hysteresis_mv: 20, smooth: 70 },
};
const RULES = { v: 1, rules: [{ id: "r32", enabled: true, on: { gpio: 32, op: "gt", value: 1000 }, then: { gpio: 4, value: 1 } }] };

interface Cmd {
  cmd: string;
  [k: string]: unknown;
}

/** Fetch stub: status, rule.list / module.list and a pluggable pin.set answer. */
function stubFetch(pinSet: (body: Cmd) => unknown = (b) => ({ v: 1, ok: true, result: { gpio: b.gpio, value: b.value } }), io: unknown = IO) {
  const commands: Cmd[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input).split("?")[0] ?? "";
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (url === `/api/devices/${ID}/v1/status`) return json({ io });
    if (url === `/api/devices/${ID}/command`) {
      const body = JSON.parse(String(init?.body)) as Cmd;
      commands.push(body);
      if (body.cmd === "rule.list") return json({ v: 1, ok: true, result: RULES });
      if (body.cmd === "module.list") return json({ v: 1, ok: true, result: { v: 1, modules: [] } });
      return json(pinSet(body));
    }
    return json({ error: "Not found", code: "not_found" }, 404);
  });
  vi.stubGlobal("fetch", fn);
  return { commands };
}

function setup(sum: Partial<DeviceSummary> = {}) {
  setDevices([summary(sum)]);
  getBrowserWs().connect();
  const ws = FakeWebSocket.last();
  act(() => ws.open());
  render(
    <MemoryRouter>
      <ToastProvider>
        <LiveTab id={ID} />
      </ToastProvider>
    </MemoryRouter>,
  );
  return ws;
}
const emit = (ws: FakeWebSocket, msg: unknown) => act(() => ws.emit(msg));

beforeEach(() => {
  resetApiForTests();
  FakeWebSocket.reset();
  vi.stubGlobal("WebSocket", FakeWebSocket);
});
afterEach(() => {
  resetApiForTests();
  vi.unstubAllGlobals();
});

describe("LiveTab", () => {
  it("renders from the REST seed, then updates in place from the WebSocket", async () => {
    stubFetch();
    const ws = setup();
    expect(await screen.findByText("Output · GPIO 4")).toBeInTheDocument();
    expect(await screen.findByText("Driven by rule r32 (GPIO 32)")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "GPIO 4" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("1.65")).toBeInTheDocument();

    emit(ws, { t: "link", id: ID, ws: "open" });
    emit(ws, { t: "live", id: ID, io: IO, telemetry: null });
    expect(screen.getByText("Live")).toBeInTheDocument();
    emit(ws, { t: "io", id: ID, topic: "io/gpio", data: { id: "gpio_4", mode: "out", gpio: 4, level: 1 } });
    emit(ws, { t: "io", id: ID, topic: "io/adc", data: { ...IO.adc_34, mv: 2475, raw: 3000 } });
    expect(screen.getByRole("switch", { name: "GPIO 4" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("2.48")).toBeInTheDocument();
  });

  it("toggling an output sends pin.set", async () => {
    const { commands } = stubFetch();
    setup();
    const sw = await screen.findByRole("switch", { name: "GPIO 4" });
    fireEvent.click(sw);
    await waitFor(() => expect(commands).toContainEqual({ cmd: "pin.set", gpio: 4, value: 1 }));
    await waitFor(() => expect(screen.getByRole("switch", { name: "GPIO 4" })).toHaveAttribute("aria-checked", "true"));
  });

  it("reverts and shows the device error verbatim when pin.set fails", async () => {
    stubFetch(() => ({ v: 1, ok: false, error: "ESP_ERR_INVALID_STATE" }));
    setup();
    const sw = await screen.findByRole("switch", { name: "GPIO 4" });
    fireEvent.click(sw);
    expect(await screen.findByText("ESP_ERR_INVALID_STATE")).toBeInTheDocument();
    expect(screen.getByText("Couldn't set GPIO 4")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("switch", { name: "GPIO 4" })).toHaveAttribute("aria-checked", "false"));
  });

  it("disables controls and greys tiles when the device is offline", async () => {
    stubFetch();
    setup({ health: "offline", lastSeen: new Date(Date.now() - 2 * 3600_000).toISOString() });
    const sw = await screen.findByRole("switch", { name: "GPIO 4" });
    expect(sw).toBeDisabled();
    expect(sw.closest(".tile")).toHaveClass("is-offline");
    expect(screen.getByText("Not live")).toBeInTheDocument();
    expect(screen.getByText(/Last values 2 h ago/)).toBeInTheDocument();
  });

  it("shows the empty state with a link to Pins & add-ons", async () => {
    stubFetch(undefined, {});
    setup();
    const link = await screen.findByRole("link", { name: "Set up pins" });
    expect(link).toHaveAttribute("href", `/devices/${ID}/pins`);
  });

  it("explains a full link", async () => {
    stubFetch();
    const ws = setup();
    await screen.findByText("Output · GPIO 4");
    emit(ws, { t: "link", id: ID, ws: "full" });
    const banner = screen.getByText(/already has 4 live viewers/);
    expect(within(banner.closest(".banner") as HTMLElement).getByText(/updating every 5 s/)).toBeInTheDocument();
    expect(screen.getByText("WS full · polling every 5 s")).toBeInTheDocument();
  });
});
