import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetApiForTests } from "../../../api/testing";
import { FakeWebSocket } from "../../../test/fakes";
import { SystemTab } from "./SystemTab";
import { makeStatus, makeSummary, renderWithProviders, routeFetch, type Call } from "./testkit";

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

const commands = (calls: Call[]) => calls.filter((c) => c.method === "POST" && c.path === `${BASE}/command`).map((c) => c.body);

function setup(extra: Parameters<typeof routeFetch>[0] = {}) {
  const status = makeStatus();
  return routeFetch({
    "GET /api/devices": { body: [makeSummary()] },
    [`GET ${BASE}/v1/status`]: { body: status },
    [`GET ${BASE}/v1/ota`]: { body: status.ota },
    [`GET ${BASE}/v1/logs`]: { body: { lines: ["I (312) boot: stage=identity", "\u001b[0;31mE (900) mqtt: error\u001b[0m"] } },
    [`POST ${BASE}/command`]: { body: { v: 1, ok: true, result: { name: "Bench", topic_id: "Bench", id: ID } } },
    ...extra,
  });
}

describe("SystemTab", () => {
  it("shows the cards from the device status", async () => {
    setup();
    renderWithProviders(<SystemTab id={ID} />);
    expect(await screen.findByRole("heading", { name: "Identity" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Firmware" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Memory" })).toBeInTheDocument();
    expect(screen.getByText("Power-on")).toBeInTheDocument();
    expect(screen.getByText("ota_0")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Update…/ })).toBeEnabled();
    expect(screen.getByRole("progressbar", { name: "Internal heap used" })).toHaveAttribute("aria-valuenow", "54");
  });

  it("renames the device with identity.set_name and previews the MQTT topic id", async () => {
    const calls = setup();
    renderWithProviders(<SystemTab id={ID} />);
    const input = await screen.findByLabelText("Name");
    const btn = screen.getByRole("button", { name: "Rename" });
    expect(btn).toBeDisabled();
    fireEvent.change(input, { target: { value: "Bench 1.0" } });
    expect(screen.getByText("devices/Bench_1_0/…")).toBeInTheDocument();
    expect(screen.getByText(/Renaming changes the device's MQTT topics and its mDNS name/)).toBeInTheDocument();
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    await waitFor(() => expect(commands(calls)).toEqual([{ cmd: "identity.set_name", name: "Bench 1.0" }]));
  });

  it("shows a device error verbatim when the rename is rejected", async () => {
    setup({ [`POST ${BASE}/command`]: { body: { v: 1, ok: false, error: "name too long" } } });
    renderWithProviders(<SystemTab id={ID} />);
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Other" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    expect(await screen.findByText("name too long")).toBeInTheDocument();
  });

  it("requires a second step and typing the name before system.factory_reset is sent", async () => {
    const calls = setup({ [`POST ${BASE}/command`]: { body: { v: 1, ok: true, result: { expectedRestart: true } } } });
    renderWithProviders(<SystemTab id={ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Factory reset…" }));
    expect(await screen.findByText(/Erases Wi-Fi, pins, add-ons, rules, MQTT, name and the Setup AP password/)).toBeInTheDocument();
    expect(screen.getByText("esp32-b3c4d5")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const confirm = await screen.findByRole("button", { name: "Factory reset" });
    expect(confirm).toBeDisabled();
    const input = screen.getByLabelText(/Type Workshop node to confirm/);
    fireEvent.change(input, { target: { value: "Workshop nod" } });
    expect(confirm).toBeDisabled();
    expect(commands(calls)).toEqual([]);
    fireEvent.change(input, { target: { value: "Workshop node" } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(commands(calls)).toEqual([{ cmd: "system.factory_reset" }]));
  });

  it("loads logs only on demand, strips ANSI codes and classifies levels", async () => {
    const calls = setup();
    renderWithProviders(<SystemTab id={ID} />);
    await screen.findByRole("heading", { name: "Logs" });
    expect(calls.some((c) => c.path === `${BASE}/v1/logs`)).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Load logs" }));
    const err = await screen.findByText("E (900) mqtt: error");
    expect(err).toHaveClass("lv-e");
    expect(screen.getByText("I (312) boot: stage=identity")).toHaveClass("lv-i");
  });

  it("shows the last known values and Retry when the device cannot be read", async () => {
    setup({ [`GET ${BASE}/v1/status`]: { status: 502, body: { ok: false, error: "Device did not answer", code: "device_unreachable", transport: true } } });
    renderWithProviders(<SystemTab id={ID} />);
    expect(await screen.findByText("Device did not answer")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.getByText("192.168.1.42")).toBeInTheDocument();
  });
});
