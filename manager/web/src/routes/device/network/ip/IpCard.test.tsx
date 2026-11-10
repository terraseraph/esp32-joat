import type { IpCheckResult, IpSettings, Job } from "@shared/api";
import type { NetworkStatus } from "@shared/device-api";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetApiForTests } from "../../../../api/testing";
import { getBrowserWs } from "../../../../api/ws";
import { ConfirmProvider, ToastProvider, TooltipProvider } from "../../../../components/ui";
import { FakeWebSocket } from "../../../../test/fakes";
import { makeJob } from "../../../../test/jobs";
import { IpCard } from "./IpCard";

const NET: NetworkStatus = {
  state: "sta_connected", sta_ip: "192.168.1.42", ap_ip: "192.168.4.1", ap_ssid: "esp32-b3c4d5", ap_open: true, hostname: "esp32-b3c4d5", rssi: -58,
  provisioned: true, sta_connected: true, ip_mode: "dhcp",
};

const DHCP: IpSettings = {
  supported: true, reason: null, ipMode: "dhcp", ip: "192.168.1.42", netmask: "255.255.255.0", gateway: "192.168.1.1", dns: "192.168.1.1",
  staConnected: true, ipChange: null, activeJobId: null,
};
const OK_CHECK: IpCheckResult = { ok: true, errors: [], warnings: [] };

interface Call {
  method: string;
  path: string;
  body: unknown;
}

interface Server {
  settings: IpSettings;
  check: (body: unknown) => IpCheckResult;
  post: () => { status: number; body: unknown };
  jobs: Job[];
}

function stub(over: Partial<Server> = {}) {
  const server: Server = { settings: DHCP, check: () => OK_CHECK, post: () => ({ status: 201, body: makeJob({ id: "j1", kind: "ip-change" }) }), jobs: [], ...over };
  const calls: Call[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = String(input).split("?")[0] ?? "";
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    calls.push({ method, path, body });
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (path === "/api/devices/dev1/ip" && method === "GET") return json(server.settings);
    if (path === "/api/devices/dev1/ip/check") return json(server.check(body));
    if (path === "/api/devices/dev1/ip" && method === "POST") {
      const r = server.post();
      return json(r.body, r.status);
    }
    if (path === "/api/jobs") return json(server.jobs);
    return json({ error: "Not found", code: "not_found" }, 404);
  });
  vi.stubGlobal("fetch", fn);
  return { calls, server };
}

function renderCard(net: NetworkStatus = NET, down = false) {
  return render(
    <TooltipProvider>
      <ToastProvider>
        <ConfirmProvider>
          <IpCard id="dev1" net={net} down={down} />
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

/** Opens the change sheet and switches to Static (the sheet opens in the device's current mode, DHCP here). */
async function openStatic() {
  fireEvent.click(await screen.findByRole("button", { name: "Change" }));
  const dlg = await screen.findByRole("dialog");
  fireEvent.click(within(dlg).getByRole("radio", { name: "Static" }));
  return dlg;
}

function type(dlg: HTMLElement, label: string, value: string) {
  const input = within(dlg).getByLabelText(label);
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}

describe("IpCard states", () => {
  it("explains older firmware and offers no edit", async () => {
    stub({ settings: { ...DHCP, supported: false, ipMode: null, reason: "The device does not report its IP mode." } });
    renderCard({ ...NET, ip_mode: undefined });
    expect(await screen.findByText("Needs newer firmware")).toBeInTheDocument();
    expect(screen.getByText(/does not report its IP mode/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Change" })).not.toBeInTheDocument();
  });

  it("shows DHCP with the live numbers", async () => {
    stub();
    renderCard();
    expect(await screen.findByText("DHCP")).toBeInTheDocument();
    expect(screen.getByText("192.168.1.42")).toBeInTheDocument();
    expect(screen.getByText("255.255.255.0 (/24)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change" })).toBeEnabled();
  });

  it("shows Static", async () => {
    stub({ settings: { ...DHCP, ipMode: "static", ip: "192.168.1.50" } });
    renderCard();
    expect(await screen.findByText("Static")).toBeInTheDocument();
    expect(screen.getByText("192.168.1.50")).toBeInTheDocument();
  });

  it("shows no mode chip when the mode is unknown", async () => {
    stub({ settings: { ...DHCP, ipMode: "unknown" } });
    renderCard();
    await screen.findByText("192.168.1.42");
    expect(screen.queryByText("DHCP")).not.toBeInTheDocument();
    expect(screen.queryByText("Static")).not.toBeInTheDocument();
  });

  it("shows a pending change with the seconds left and blocks a new one", async () => {
    stub({
      settings: { ...DHCP, ipMode: "static", ipChange: { result: "pending", mode: "static", ip: "192.168.1.60", applied: true, confirm_left_s: 42 } },
    });
    renderCard();
    expect(await screen.findByText(/42 s left to confirm/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change" })).toBeDisabled();
    expect(screen.getByText("The previous change is still waiting for confirmation.")).toBeInTheDocument();
  });

  it("says in words that the last change was reverted, and that a Wi-Fi change reset it", async () => {
    stub({ settings: { ...DHCP, ipChange: { result: "reverted", reason: "not_confirmed", mode: "static" } } });
    const first = renderCard();
    expect(await screen.findByText(/not confirmed in time. The device went back to its previous setting/)).toBeInTheDocument();
    first.unmount();
    stub({ settings: { ...DHCP, ipChange: { result: "reset" } } });
    renderCard();
    expect(await screen.findByText(/fixed address was dropped because the Wi-Fi network changed/)).toBeInTheDocument();
  });

  it("disables Change while the device is not answering", async () => {
    stub();
    renderCard(NET, true);
    await screen.findByText("192.168.1.42");
    expect(screen.getByRole("button", { name: "Change" })).toBeDisabled();
  });

  it("shows the failure when the settings cannot be read, with a retry", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Cannot reach the device.", code: "device_unreachable" }), { status: 502 })));
    renderCard();
    expect(await screen.findByText("Cannot reach the device.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });
});

describe("IpCard edit sheet", () => {
  it("opens in the mode the device is in now", async () => {
    stub({ settings: { ...DHCP, ipMode: "dhcp" } });
    const first = renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Change" }));
    let dlg = await screen.findByRole("dialog");
    expect(within(dlg).getByRole("radio", { name: "DHCP" })).toHaveAttribute("aria-checked", "true");
    first.unmount();

    resetApiForTests();
    stub({ settings: { ...DHCP, ipMode: "static", ip: "192.168.1.50" } });
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Change" }));
    dlg = await screen.findByRole("dialog");
    expect(within(dlg).getByRole("radio", { name: "Static" })).toHaveAttribute("aria-checked", "true");
  });

  it("validates as the device does, without waiting for the server", async () => {
    const { calls } = stub();
    renderCard();
    const dlg = await openStatic();
    const submit = within(dlg).getByRole("button", { name: "Use this address" });
    expect(submit).toBeDisabled();

    type(dlg, "IP address", "192.168.01.50");
    expect(await within(dlg).findByText(/four numbers from 0 to 255/)).toBeInTheDocument();
    type(dlg, "IP address", "192.168.1.50");
    type(dlg, "Netmask", "255.0.255.0");
    expect(await within(dlg).findByText(/Not a usable netmask/)).toBeInTheDocument();
    type(dlg, "Netmask", "255.255.255.0");
    type(dlg, "Gateway", "192.168.2.1");
    expect(await within(dlg).findByText(/same subnet/)).toBeInTheDocument();
    expect(submit).toBeDisabled();
    type(dlg, "Gateway", "192.168.1.1");
    await waitFor(() => expect(submit).toBeEnabled());
    expect(calls.some((c) => c.path.endsWith("/check") && (c.body as { gateway?: string }).gateway === "192.168.2.1")).toBe(false);
  });

  it("fills the fields from the current values", async () => {
    stub({ settings: { ...DHCP, ipMode: "dhcp" } });
    renderCard();
    const dlg = await openStatic();
    fireEvent.click(within(dlg).getByRole("button", { name: "Use current values" }));
    expect(within(dlg).getByLabelText("IP address")).toHaveValue("192.168.1.42");
    expect(within(dlg).getByLabelText("Netmask")).toHaveValue("255.255.255.0");
    expect(within(dlg).getByLabelText("Gateway")).toHaveValue("192.168.1.1");
    expect(within(dlg).getByLabelText("DNS server (optional)")).toHaveValue("192.168.1.1");
  });

  it("shows the server's warnings as notes that do not block", async () => {
    stub({
      check: () => ({
        ok: true,
        errors: [],
        warnings: [
          { code: "outside_pc_subnets", message: "This address is outside the networks this PC is on." },
          { code: "address_in_use", message: "Bench node already uses this address." },
        ],
      }),
    });
    renderCard();
    const dlg = await openStatic();
    type(dlg, "IP address", "10.1.1.50");
    type(dlg, "Netmask", "255.255.255.0");
    type(dlg, "Gateway", "10.1.1.1");
    expect(await within(dlg).findByText(/outside the networks this PC is on/)).toBeInTheDocument();
    expect(within(dlg).getByText(/Bench node already uses this address/)).toBeInTheDocument();
    expect(within(dlg).getByRole("button", { name: "Use this address" })).toBeEnabled();
  });

  it("shows an error from the server's check on its field and blocks saving", async () => {
    stub({ check: () => ({ ok: false, errors: [{ field: "ip", message: "The device does not accept this address." }], warnings: [] }) });
    renderCard();
    const dlg = await openStatic();
    type(dlg, "IP address", "192.168.1.50");
    type(dlg, "Netmask", "255.255.255.0");
    type(dlg, "Gateway", "192.168.1.1");
    expect(await within(dlg).findByText("The device does not accept this address.")).toBeInTheDocument();
    expect(within(dlg).getByRole("button", { name: "Use this address" })).toBeDisabled();
  });

  it("only allows DHCP while the device is not on Wi-Fi", async () => {
    stub({ settings: { ...DHCP, staConnected: false, ip: "", netmask: "", gateway: "", dns: "" } });
    renderCard();
    const dlg = await openStatic();
    expect(within(dlg).getByRole("radio", { name: "Static" })).toHaveAttribute("aria-disabled", "true");
    expect(within(dlg).getByText(/not connected to Wi-Fi right now. DHCP is saved/)).toBeInTheDocument();
    expect(within(dlg).getByRole("button", { name: "Switch to DHCP" })).toBeEnabled();
  });

  it("explains the 90 second confirm", async () => {
    stub();
    renderCard();
    const dlg = await openStatic();
    expect(within(dlg).getByText(/90 seconds to reach it and confirm/)).toBeInTheDocument();
  });
});

describe("IpCard job flow", () => {
  function openSocket() {
    getBrowserWs().connect();
    act(() => FakeWebSocket.last().open());
  }

  async function startStatic() {
    const dlg = await openStatic();
    type(dlg, "IP address", "192.168.1.50");
    type(dlg, "Netmask", "255.255.255.0");
    type(dlg, "Gateway", "192.168.1.1");
    const submit = within(dlg).getByRole("button", { name: "Use this address" });
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);
    const confirmDlg = await screen.findByRole("dialog", { name: /Change the address to 192\.168\.1\.50\?/ });
    fireEvent.click(within(confirmDlg).getByRole("button", { name: "Change address" }));
  }

  const RUNNING = makeJob({
    id: "j1",
    kind: "ip-change",
    title: "Change address of Bench node",
    steps: [
      { id: "check", label: "Check the device", status: "done" },
      { id: "reach", label: "Reach it at the new address", status: "done" },
      { id: "confirm", label: "Confirm (keeps the change)", status: "running", detail: "Confirming: 61 s left" },
    ],
  });

  it("sends the static settings, then follows the job with the countdown and the result in words", async () => {
    const { calls } = stub({ post: () => ({ status: 201, body: RUNNING }) });
    renderCard();
    openSocket();
    await startStatic();

    expect(await screen.findByText("Confirming: 61 s left")).toBeInTheDocument();
    const post = calls.find((c) => c.method === "POST" && c.path === "/api/devices/dev1/ip");
    expect(post?.body).toEqual({ mode: "static", ip: "192.168.1.50", netmask: "255.255.255.0", gateway: "192.168.1.1" });
    expect(screen.getByText(/Cancelling before the confirm step/)).toBeInTheDocument();

    const settingsReads = () => calls.filter((c) => c.method === "GET" && c.path === "/api/devices/dev1/ip").length;
    const before = settingsReads();
    act(() =>
      FakeWebSocket.last().emit({
        t: "job",
        job: {
          ...RUNNING,
          state: "succeeded",
          progress: 1,
          actions: [],
          steps: RUNNING.steps.map((s) => ({ ...s, status: "done" as const })),
          result: { outcome: "ok", reason: null, host: "192.168.1.50", ipMode: "static" },
          updatedAt: "2026-11-10T09:01:00.000Z",
          finishedAt: "2026-11-10T09:01:00.000Z",
        },
      }),
    );
    expect(await screen.findByText("The new address is in use.")).toBeInTheDocument();
    expect(screen.getByText(/reached the device at 192\.168\.1\.50 and confirmed/)).toBeInTheDocument();
    await waitFor(() => expect(settingsReads()).toBeGreaterThan(before)); // the card reads the settings again
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("The new address is in use.")).not.toBeInTheDocument();
  });

  it("switches to DHCP without a danger dialog", async () => {
    const { calls } = stub({ settings: { ...DHCP, ipMode: "static", ip: "192.168.1.50" }, post: () => ({ status: 201, body: RUNNING }) });
    renderCard();
    openSocket();
    const dlg = await openStatic();
    fireEvent.click(within(dlg).getByRole("radio", { name: "DHCP" }));
    fireEvent.click(within(dlg).getByRole("button", { name: "Switch to DHCP" }));
    expect(await screen.findByText("Confirming: 61 s left")).toBeInTheDocument();
    expect(calls.find((c) => c.method === "POST" && c.path === "/api/devices/dev1/ip")?.body).toEqual({ mode: "dhcp" });
  });

  it("tells the user the device went back when the new address could not be reached", async () => {
    stub({ post: () => ({ status: 201, body: RUNNING }) });
    renderCard();
    openSocket();
    await startStatic();
    await screen.findByText("Confirming: 61 s left");
    act(() =>
      FakeWebSocket.last().emit({
        t: "job",
        job: {
          ...RUNNING,
          state: "failed",
          actions: [],
          error: { code: "reverted", message: "Could not reach the device at 192.168.1.50; it went back to 192.168.1.42 (DHCP) by itself. Nothing was changed.", step: "revert" },
          result: { outcome: "reverted", reason: "Could not reach the device at 192.168.1.50; it went back to 192.168.1.42 (DHCP) by itself. Nothing was changed.", host: "192.168.1.42", ipMode: "dhcp" },
          updatedAt: "2026-11-10T09:01:00.000Z",
          finishedAt: "2026-11-10T09:01:00.000Z",
        },
      }),
    );
    expect(await screen.findByText("The device went back to its previous setting.")).toBeInTheDocument();
    expect(screen.getAllByText(/Could not reach the device at 192\.168\.1\.50; it went back to 192\.168\.1\.42 \(DHCP\) by itself\. Nothing was changed\./).length).toBeGreaterThan(0);
  });

  it("shows the waiting step with its countdown, then the not-reachable outcome", async () => {
    stub({ post: () => ({ status: 201, body: RUNNING }) });
    renderCard();
    openSocket();
    await startStatic();
    await screen.findByText("Confirming: 61 s left");
    const waiting = {
      ...RUNNING,
      steps: [
        { id: "reach", label: "Reach it at the new address", status: "failed" as const, detail: "The Manager could not reach the device at 192.168.1.50." },
        { id: "revert", label: "Waiting for the device to go back to its previous setting", status: "running" as const, detail: "42 seconds left. Checking 192.168.1.42." },
      ],
    };
    act(() => FakeWebSocket.last().emit({ t: "job", job: waiting }));
    expect(await screen.findByText("Waiting for the device to go back to its previous setting")).toBeInTheDocument();
    expect(screen.getByText("42 seconds left. Checking 192.168.1.42.")).toBeInTheDocument();
    expect(screen.getByText(/Cancel stops the Manager from waiting/)).toBeInTheDocument();
    act(() =>
      FakeWebSocket.last().emit({
        t: "job",
        job: {
          ...waiting,
          state: "failed",
          actions: [],
          error: { code: "not_reachable", message: "The Manager could not reach the device at 192.168.1.50, and it did not answer at its old address either. Run a scan.", step: "revert" },
          result: { outcome: "unknown", reason: "x", host: "192.168.1.42", ipMode: "static" },
          updatedAt: "2026-11-10T09:02:00.000Z",
          finishedAt: "2026-11-10T09:02:00.000Z",
        },
      }),
    );
    expect(await screen.findByText("The Manager could not find the device.")).toBeInTheDocument();
    expect(screen.getAllByText(/did not answer at its old address either/).length).toBeGreaterThan(0);
  });

  it("shows the server's refusal and keeps the dialog open", async () => {
    stub({ post: () => ({ status: 409, body: { error: "This device has no saved Wi-Fi network, so it cannot change its address.", code: "ip_change_refused" } }) });
    renderCard();
    await startStatic();
    expect((await screen.findAllByText(/no saved Wi-Fi network/)).length).toBeGreaterThan(0);
    expect(screen.getByRole("dialog", { name: /Change the address to/ })).toBeInTheDocument();
  });

  it("follows a job that is already running when the page opens", async () => {
    const running = { ...RUNNING, state: "running" as const };
    stub({ settings: { ...DHCP, activeJobId: "j1" }, jobs: [running] });
    renderCard();
    openSocket();
    expect(await screen.findByText("Confirming: 61 s left")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change" })).toBeDisabled();
  });
});
