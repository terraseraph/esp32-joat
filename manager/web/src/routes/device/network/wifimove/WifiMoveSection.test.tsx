import type { Job, SetupAdapterStatus, WifiMoveCheckResult, WifiMoveSettings } from "@shared/api";
import type { NetworkStatus } from "@shared/device-api";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetApiForTests } from "../../../../api/testing";
import { getBrowserWs } from "../../../../api/ws";
import { ConfirmProvider, ToastProvider, TooltipProvider } from "../../../../components/ui";
import { FakeWebSocket } from "../../../../test/fakes";
import { makeJob } from "../../../../test/jobs";
import { WifiMoveSection } from "./WifiMoveSection";

const NET: NetworkStatus = {
  state: "sta_connected", sta_ip: "192.168.1.42", ap_ip: "192.168.4.1", ap_ssid: "esp32-b3c4d5", ap_open: true, hostname: "esp32-b3c4d5", rssi: -58,
  provisioned: true, sta_connected: true, wifi_change: { result: "none" },
};
const SETTINGS: WifiMoveSettings = {
  supported: true, reason: null, state: "sta_connected", connected: true, ip: "192.168.1.42", hostname: "esp32-b3c4d5", ipMode: "dhcp", staticIp: false,
  lastChange: null, pcSsid: "HomeNet", pcSsidKnown: true, setupApAvailable: true, activeJobId: null,
};
const OK_CHECK: WifiMoveCheckResult = { ok: true, errors: [], warnings: [] };
const ADAPTER: SetupAdapterStatus = { kind: "fake", supported: true, reason: null, interfaceName: "Wi-Fi", connectedSsid: "HomeNet", localAddress: null };
const NAME = "Workshop node";

interface Call {
  method: string;
  path: string;
  body: unknown;
}

interface Server {
  settings: WifiMoveSettings;
  check: (body: unknown) => WifiMoveCheckResult;
  post: () => { status: number; body: unknown };
  scan: unknown;
  adapter: SetupAdapterStatus;
  jobs: Job[];
}

function stub(over: Partial<Server> = {}) {
  const server: Server = {
    settings: SETTINGS,
    check: () => OK_CHECK,
    post: () => ({ status: 202, body: makeJob({ id: "j1", kind: "wifi-move" }) }),
    scan: [
      { ssid: "workshop-wifi", rssi: -48, channel: 6, auth: 3 },
      { ssid: "guest", rssi: -61, channel: 1, auth: 0 },
      { ssid: "workshop-wifi", rssi: -70, channel: 11, auth: 3 },
    ],
    adapter: ADAPTER,
    jobs: [],
    ...over,
  };
  const calls: Call[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = String(input).split("?")[0] ?? "";
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    calls.push({ method, path, body });
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (path === "/api/devices/dev1/wifi" && method === "GET") return json(server.settings);
    if (path === "/api/devices/dev1/wifi/check") return json(server.check(body));
    if (path === "/api/devices/dev1/wifi" && method === "POST") {
      const r = server.post();
      return json(r.body, r.status);
    }
    if (path === "/api/devices/dev1/v1/network/scan") return json(server.scan);
    if (path === "/api/setup/adapter") return json(server.adapter);
    if (path === "/api/jobs") return json(server.jobs);
    return json({ error: "Not found", code: "not_found" }, 404);
  });
  vi.stubGlobal("fetch", fn);
  return { calls, server };
}

function renderSection(net: NetworkStatus = NET, down = false) {
  return render(
    <TooltipProvider>
      <ToastProvider>
        <ConfirmProvider>
          <WifiMoveSection id="dev1" net={net} deviceName={NAME} down={down} />
        </ConfirmProvider>
      </ToastProvider>
    </TooltipProvider>,
  );
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

async function openSheet() {
  fireEvent.click(await screen.findByRole("button", { name: "Move to another Wi-Fi network" }));
  return screen.findByRole("dialog");
}

function fill(dlg: HTMLElement, label: string, value: string) {
  const input = within(dlg).getByLabelText(label);
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}

describe("availability", () => {
  it("is hidden on firmware without wifi_change: a muted line, no button, no request", async () => {
    const { calls } = stub();
    const { wifi_change: _drop, ...old } = NET;
    void _drop;
    renderSection(old);
    expect(screen.getByText("Moving to another Wi-Fi network needs newer firmware.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Move to another Wi-Fi network" })).not.toBeInTheDocument();
    await Promise.resolve();
    expect(calls.some((c) => c.path.endsWith("/wifi"))).toBe(false);
  });

  it("shows the button on supporting firmware", async () => {
    stub();
    renderSection();
    expect(await screen.findByRole("button", { name: "Move to another Wi-Fi network" })).toBeEnabled();
  });

  it("is disabled with the reason while the device is not answering", async () => {
    stub();
    renderSection(NET, true);
    expect(await screen.findByRole("button", { name: "Move to another Wi-Fi network" })).toBeDisabled();
    expect(screen.getByText("The device isn't answering right now.")).toBeInTheDocument();
  });
});

describe("the sheet", () => {
  it("validates the name and the password before anything is sent", async () => {
    const { calls } = stub();
    renderSection();
    const dlg = await openSheet();
    const go = within(dlg).getByRole("button", { name: "Continue" });
    expect(go).toBeDisabled();
    fill(dlg, "Network name", "workshop-wifi");
    fill(dlg, "Password", "short");
    expect(await within(dlg).findByText(/8 to 63 characters/)).toBeInTheDocument();
    expect(go).toBeDisabled();
    fill(dlg, "Password", "correct-horse-battery");
    await waitFor(() => expect(go).toBeEnabled());
    fill(dlg, "Network name", "a".repeat(33));
    expect(await within(dlg).findByText(/at most 32 bytes/)).toBeInTheDocument();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("picks a network from the device's own scan (one row per name, signal shown, secured ones marked)", async () => {
    stub();
    renderSection();
    const dlg = await openSheet();
    fireEvent.click(within(dlg).getByRole("button", { name: "Scan from the device" }));
    const list = await within(dlg).findByRole("list", { name: "Networks the device can see" });
    const rows = within(list).getAllByRole("button");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("workshop-wifi");
    expect(rows[0]).toHaveTextContent("-48 dBm");
    expect(within(rows[0]!).getByLabelText("Needs a password")).toBeInTheDocument();
    expect(within(rows[1]!).queryByLabelText("Needs a password")).not.toBeInTheDocument();
    fireEvent.click(rows[0]!);
    expect(within(dlg).getByLabelText("Network name")).toHaveValue("workshop-wifi");
  });

  it("shows the server's warnings without blocking, and its errors with blocking", async () => {
    let result: WifiMoveCheckResult = {
      ok: true,
      errors: [],
      warnings: [
        { code: "pc_other_network", message: 'This PC is on "HomeNet", not on "workshop-wifi".' },
        { code: "static_ip_reset", message: "This device uses a fixed address. On the new network it goes back to DHCP." },
      ],
    };
    const { calls } = stub({ check: () => result });
    renderSection();
    const dlg = await openSheet();
    fill(dlg, "Network name", "workshop-wifi");
    fill(dlg, "Password", "correct-horse-battery");
    expect(await within(dlg).findByText(/This PC is on "HomeNet"/)).toBeInTheDocument();
    expect(within(dlg).getByText(/goes back to DHCP/)).toBeInTheDocument();
    expect(within(dlg).getByRole("button", { name: "Continue" })).toBeEnabled();
    expect(within(dlg).getByText(/up to 20 seconds/)).toBeInTheDocument();
    // The check never receives the real password.
    const check = calls.find((c) => c.path.endsWith("/check"));
    expect(JSON.stringify(check?.body)).not.toContain("correct-horse-battery");

    result = { ok: false, errors: [{ field: "device", message: "The device is testing a Wi-Fi change right now." }], warnings: [] };
    fill(dlg, "Network name", "workshop-wifi2");
    expect(await within(dlg).findByText(/testing a Wi-Fi change right now/)).toBeInTheDocument();
    expect(within(dlg).getByRole("button", { name: "Continue" })).toBeDisabled();
  });
});

describe("confirmation and the job", () => {
  function openSocket() {
    getBrowserWs().connect();
    act(() => FakeWebSocket.last().open());
  }

  async function toConfirm() {
    const dlg = await openSheet();
    fill(dlg, "Network name", "workshop-wifi");
    fill(dlg, "Password", "correct-horse-battery");
    const go = within(dlg).getByRole("button", { name: "Continue" });
    await waitFor(() => expect(go).toBeEnabled());
    fireEvent.click(go);
    return screen.findByRole("dialog", { name: /Move Workshop node to "workshop-wifi"\?/ });
  }

  const RUNNING = makeJob({
    id: "j1",
    kind: "wifi-move",
    title: 'Move Workshop node to "workshop-wifi"',
    steps: [
      { id: "send", label: "Send the new network", status: "done" },
      { id: "switch", label: "Device tries the new network", status: "running", detail: "The device tests the network for up to 20 seconds." },
    ],
  });

  it("needs the device's name typed before it sends anything", async () => {
    const { calls } = stub({ post: () => ({ status: 202, body: RUNNING }) });
    renderSection();
    openSocket();
    const confirmDlg = await toConfirm();
    expect(within(confirmDlg).getByText(/stop answering for up to about 30 seconds/)).toBeInTheDocument();
    const move = within(confirmDlg).getByRole("button", { name: "Move device" });
    expect(move).toBeDisabled();
    fireEvent.change(within(confirmDlg).getByLabelText(/type/i), { target: { value: "workshop" } });
    expect(move).toBeDisabled();
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/devices/dev1/wifi")).toBe(false);
    fireEvent.change(within(confirmDlg).getByLabelText(/type/i), { target: { value: NAME } });
    expect(move).toBeEnabled();
    fireEvent.click(move);

    expect(await screen.findByText("The device tests the network for up to 20 seconds.")).toBeInTheDocument();
    const post = calls.find((c) => c.method === "POST" && c.path === "/api/devices/dev1/wifi");
    expect(post?.body).toEqual({ ssid: "workshop-wifi", password: "correct-horse-battery" });
    expect(screen.getByText(/goes back to its current one by itself/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Move to another Wi-Fi network" })).toBeDisabled();
  });

  async function finishWith(over: Partial<Job>) {
    const { calls } = stub({ post: () => ({ status: 202, body: RUNNING }) });
    renderSection();
    openSocket();
    const confirmDlg = await toConfirm();
    fireEvent.change(within(confirmDlg).getByLabelText(/type/i), { target: { value: NAME } });
    fireEvent.click(within(confirmDlg).getByRole("button", { name: "Move device" }));
    await screen.findByText("The device tests the network for up to 20 seconds.");
    act(() =>
      FakeWebSocket.last().emit({
        t: "job",
        job: { ...RUNNING, actions: [], updatedAt: "2026-11-10T09:01:00.000Z", finishedAt: "2026-11-10T09:01:00.000Z", ...over },
      }),
    );
    return calls;
  }

  it("ending 1: found on the new network, with the address change and the DHCP reset in words", async () => {
    const calls = await finishWith({
      state: "succeeded",
      progress: 1,
      result: { outcome: "ok", ssid: "workshop-wifi", reason: null, reasonCode: null, restoredPrevious: null, oldHost: "192.168.1.42", newHost: "10.0.0.7", addressChanged: true, staticIpReset: true },
    });
    expect(await screen.findByText('The device is on "workshop-wifi" now.')).toBeInTheDocument();
    expect(screen.getByText(/found it again by its ID.*now uses at 10\.0\.0\.7/)).toBeInTheDocument();
    expect(screen.getByText(/fixed address was dropped/)).toBeInTheDocument();
    await waitFor(() => expect(calls.filter((c) => c.method === "GET" && c.path === "/api/devices/dev1/wifi").length).toBeGreaterThan(1));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText('The device is on "workshop-wifi" now.')).not.toBeInTheDocument();
  });

  it("ending 2: it could not join and went back, with the device's reason", async () => {
    await finishWith({
      state: "failed",
      error: { code: "auth", message: "The network refused the password. Check it and try again. The device went back to its previous network, so nothing changed.", step: "switch" },
      result: { outcome: "failed", ssid: "workshop-wifi", reason: "x", reasonCode: "auth", restoredPrevious: true, oldHost: "192.168.1.42", newHost: "192.168.1.42", addressChanged: false, staticIpReset: false },
    });
    expect(await screen.findByText("The device could not join the new network.")).toBeInTheDocument();
    expect(screen.getAllByText(/refused the password/).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Recover over its setup Wi-Fi" })).not.toBeInTheDocument();
  });

  it("ending 3: not found, with the recovery advice and a way to the setup Wi-Fi recovery", async () => {
    await finishWith({
      state: "failed",
      error: { code: "not_found", message: "The Manager did not see the device again within 90 seconds.", step: "find" },
      result: { outcome: "not_found", ssid: "workshop-wifi", reason: "x", reasonCode: null, restoredPrevious: null, oldHost: "192.168.1.42", newHost: null, addressChanged: false, staticIpReset: false },
    });
    expect(await screen.findByText("The Manager did not see the device again.")).toBeInTheDocument();
    expect(screen.getByText(/Connect this PC to that network and scan from Discover/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Recover over its setup Wi-Fi" })).toBeInTheDocument();
  });

  it("an error from the server is shown in the confirmation and nothing is followed", async () => {
    stub({ post: () => ({ status: 409, body: { error: "A Wi-Fi move for this device is already running.", code: "job_running" } }) });
    renderSection();
    const confirmDlg = await toConfirm();
    fireEvent.change(within(confirmDlg).getByLabelText(/type/i), { target: { value: NAME } });
    fireEvent.click(within(confirmDlg).getByRole("button", { name: "Move device" }));
    expect((await screen.findAllByText(/already running/)).length).toBeGreaterThan(0);
  });

  it("follows a move that is already running (page opened mid-move)", async () => {
    stub({
      settings: { ...SETTINGS, activeJobId: "j9" },
      jobs: [makeJob({ id: "j9", kind: "wifi-move", title: 'Move Workshop node to "guest"', steps: [{ id: "find", label: "Find the device again", status: "running" }] })],
    });
    renderSection();
    expect(await screen.findByText("Find the device again")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Move to another Wi-Fi network" })).toBeDisabled();
  });
});
