import type { Job } from "@shared/api";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetSetupRecovery } from "../../../api/setup";
import { healthStore } from "../../../api/serverStatus";
import { resetApiForTests } from "../../../api/testing";
import { getBrowserWs } from "../../../api/ws";
import { FakeWebSocket, HEALTH } from "../../../test/fakes";
import { makeJob } from "../../../test/jobs";
import { renderWithProviders, routeFetch, type Call } from "../../device/system/testkit";
import { SetupSection } from "./SetupSection";

const SUPPORTED = { supported: true, reason: null, scannedAt: "2026-11-10T09:00:00.000Z" };
const AP_SECURED = { ssid: "esp32-aabbcc", idSuffix: "aabbcc", secured: true, signal: 80, knownDeviceId: null };
const AP_OPEN = { ssid: "esp32-112233", idSuffix: "112233", secured: false, signal: 20, knownDeviceId: null };
const NO_MARKER = { pending: false, marker: null };

let tick = 0;
/** A setup job; `updatedAt` grows so the store accepts each newer copy. */
function setupJob(over: Partial<Job> = {}): Job {
  tick += 1;
  return makeJob({
    id: "s1",
    kind: "setup",
    title: "Set up esp32-aabbcc",
    state: "running",
    progress: null,
    params: { ssid: "esp32-aabbcc" },
    steps: [
      { id: "join_ap", label: "Join the device's setup Wi-Fi", status: "running" },
      { id: "choose", label: "Choose a network", status: "pending" },
    ],
    updatedAt: `2026-11-10T09:${String(Math.floor(tick / 60)).padStart(2, "0")}:${String(tick % 60).padStart(2, "0")}.000Z`,
    ...over,
  });
}

const waitingJob = () =>
  setupJob({
    message: "Choose the network for the device",
    steps: [
      { id: "join_ap", label: "Join the device's setup Wi-Fi", status: "done" },
      { id: "choose", label: "Choose a network", status: "running" },
    ],
    result: {
      networks: [
        { ssid: "Cafe", rssi: -80, secure: false },
        { ssid: "Home", rssi: -45, secure: true },
      ],
      device: { id: "aabbccddeeff", name: "Bench node", fw: "0.1.0", app_version: "9dcba89" },
    },
  });

function openSocket() {
  getBrowserWs().connect();
  act(() => FakeWebSocket.last().open());
}
const push = (job: Job) => act(() => FakeWebSocket.last().emit({ t: "job", job }));
const posted = (calls: Call[], path: string) => calls.filter((c) => c.method === "POST" && c.path === path);

beforeEach(() => {
  tick = 0;
  resetApiForTests();
  resetSetupRecovery();
  FakeWebSocket.reset();
  vi.stubGlobal("WebSocket", FakeWebSocket);
});
afterEach(() => {
  resetApiForTests();
  vi.unstubAllGlobals();
});

describe("SetupSection states", () => {
  it("stays out of the way when the server has no setup routes", async () => {
    const calls = routeFetch({});
    renderWithProviders(<SetupSection />);
    await waitFor(() => expect(calls.some((c) => c.path === "/api/setup/aps")).toBe(true));
    await waitFor(() => expect(screen.queryByLabelText(/Looking for devices/)).not.toBeInTheDocument());
    expect(screen.queryByText("Devices in setup mode")).not.toBeInTheDocument();
  });

  it("explains why setup is unavailable and offers no Refresh", async () => {
    routeFetch({
      "GET /api/setup/aps": { body: { supported: false, reason: "SoftAP setup is supported on Windows only for now.", aps: [], scannedAt: null } },
      "GET /api/setup/recovery": { body: NO_MARKER },
    });
    renderWithProviders(<SetupSection />);
    expect(await screen.findByText(/supported on Windows only for now/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Refresh/ })).not.toBeInTheDocument();
  });

  it("shows an empty state and rescans on Refresh", async () => {
    routeFetch({ "GET /api/setup/aps": { body: { ...SUPPORTED, aps: [] } }, "GET /api/setup/recovery": { body: NO_MARKER } });
    renderWithProviders(<SetupSection />);
    expect(await screen.findByText("No device in setup mode nearby.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
    await waitFor(() => {
      const urls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
      expect(urls).toContain("/api/setup/aps?refresh=true");
    });
  });

  it("lists nearby setup APs; a known device says Recover", async () => {
    routeFetch({
      "GET /api/setup/aps": { body: { ...SUPPORTED, aps: [AP_SECURED, { ...AP_OPEN, knownDeviceId: "30aea4112233" }] } },
      "GET /api/setup/recovery": { body: NO_MARKER },
    });
    renderWithProviders(<SetupSection />);
    const list = await screen.findByRole("list", { name: "Devices in setup mode" });
    expect(within(list).getByText("esp32-aabbcc")).toBeInTheDocument();
    expect(within(list).getByText("Password protected")).toBeInTheDocument();
    expect(within(list).getByText("In your fleet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set up esp32-aabbcc" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Recover esp32-112233" })).toBeEnabled();
  });
});

describe("guided setup", () => {
  it("runs the happy path: intro, start, choose a network, success with a link to the device", async () => {
    const calls = routeFetch({
      "GET /api/setup/aps": { body: { ...SUPPORTED, aps: [AP_SECURED] } },
      "GET /api/setup/recovery": { body: NO_MARKER },
      "GET /api/jobs": { body: [] },
      "POST /api/setup/jobs": { status: 201, body: setupJob() },
      "POST /api/setup/jobs/s1/wifi": () => ({ body: setupJob({ steps: [{ id: "send_wifi", label: "Send Wi-Fi details", status: "running" }], result: undefined }) }),
    });
    openSocket();
    renderWithProviders(<SetupSection />);

    fireEvent.click(await screen.findByRole("button", { name: "Set up esp32-aabbcc" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/leaves its Wi-Fi for about a minute/)).toBeInTheDocument();
    expect(within(dialog).getByText("Factory reset first")).toBeInTheDocument();

    // the AP is secured: a password is required
    fireEvent.click(within(dialog).getByRole("button", { name: "Start setup" }));
    expect(await within(dialog).findByText("Enter the setup Wi-Fi password.")).toBeInTheDocument();
    expect(posted(calls, "/api/setup/jobs")).toHaveLength(0);

    fireEvent.change(within(dialog).getByLabelText(/Setup Wi-Fi password/), { target: { value: "ap-secret-1" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Start setup" }));
    await waitFor(() => expect(posted(calls, "/api/setup/jobs")).toHaveLength(1));
    expect(posted(calls, "/api/setup/jobs")[0]?.body).toEqual({ ssid: "esp32-aabbcc", apPassword: "ap-secret-1" });

    // the job shows its steps
    expect(await screen.findByRole("list", { name: "Steps" })).toBeInTheDocument();
    expect(screen.getByText("Join the device's setup Wi-Fi")).toBeInTheDocument();

    // the job waits for a choice: networks sorted by signal
    push(waitingJob());
    const form = await screen.findByRole("form", { name: "Choose the device's network" });
    expect(within(form).getByText("Choose the network for Bench node")).toBeInTheDocument();
    const names = within(form)
      .getAllByRole("radio")
      .map((r) => (r as HTMLInputElement).value);
    expect(names[0]).toBe("Home");
    expect(names[1]).toBe("Cafe");

    // nothing picked yet
    fireEvent.click(within(form).getByRole("button", { name: /Send to device/ }));
    expect(await within(form).findByText("Pick a network.")).toBeInTheDocument();

    fireEvent.click(within(form).getByRole("radio", { name: /Home/ }));
    fireEvent.click(within(form).getByRole("button", { name: /Send to device/ }));
    expect(await within(form).findByText("Enter the Wi-Fi password.")).toBeInTheDocument();
    expect(posted(calls, "/api/setup/jobs/s1/wifi")).toHaveLength(0);

    fireEvent.change(within(form).getByLabelText(/Wi-Fi password/), { target: { value: "home-pass" } });
    fireEvent.click(within(form).getByRole("button", { name: /Send to device/ }));
    await waitFor(() => expect(posted(calls, "/api/setup/jobs/s1/wifi")).toHaveLength(1));
    expect(posted(calls, "/api/setup/jobs/s1/wifi")[0]?.body).toEqual({ ssid: "Home", password: "home-pass" });
    await waitFor(() => expect(screen.queryByRole("form", { name: "Choose the device's network" })).not.toBeInTheDocument());

    push(
      setupJob({
        state: "succeeded",
        steps: [{ id: "add", label: "Add to the fleet", status: "done" }],
        actions: [],
        finishedAt: "2026-11-10T09:01:00.000Z",
        result: { deviceId: "aabbccddeeff", host: "192.168.1.77", name: "Bench node", added: true },
      }),
    );
    expect(await screen.findByText("Bench node is on your network")).toBeInTheDocument();
    expect(screen.getByText(/It was added to your fleet./)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open the device/ })).toHaveAttribute("href", "/devices/aabbccddeeff");
  });

  it("lets you type a network the device did not list; an open network is sent without a password", async () => {
    const calls = routeFetch({
      "GET /api/setup/aps": { body: { ...SUPPORTED, aps: [AP_OPEN] } },
      "GET /api/setup/recovery": { body: NO_MARKER },
      "GET /api/jobs": { body: [] },
      "POST /api/setup/jobs": { status: 201, body: setupJob({ params: { ssid: "esp32-112233" } }) },
      "POST /api/setup/jobs/s1/wifi": () => ({ body: setupJob() }),
    });
    openSocket();
    renderWithProviders(<SetupSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Set up esp32-112233" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByLabelText(/Setup Wi-Fi password/)).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByLabelText(/Factory reset first/));
    fireEvent.click(within(dialog).getByRole("button", { name: "Reset and start setup" }));
    await waitFor(() => expect(posted(calls, "/api/setup/jobs")).toHaveLength(1));
    expect(posted(calls, "/api/setup/jobs")[0]?.body).toEqual({ ssid: "esp32-112233", factoryResetFirst: true });

    push(waitingJob());
    const form = await screen.findByRole("form", { name: "Choose the device's network" });
    fireEvent.click(within(form).getByRole("radio", { name: /Another network/ }));
    fireEvent.change(within(form).getByLabelText(/Network name/), { target: { value: "Hidden net" } });
    fireEvent.click(within(form).getByRole("button", { name: /Send to device/ }));
    await waitFor(() => expect(posted(calls, "/api/setup/jobs/s1/wifi")).toHaveLength(1));
    expect(posted(calls, "/api/setup/jobs/s1/wifi")[0]?.body).toEqual({ ssid: "Hidden net" });
  });

  it("shows a refused start in plain words", async () => {
    routeFetch({
      "GET /api/setup/aps": { body: { ...SUPPORTED, aps: [AP_OPEN] } },
      "GET /api/setup/recovery": { body: NO_MARKER },
      "GET /api/jobs": { body: [] },
      "POST /api/setup/jobs": { status: 409, body: { error: "A setup is already running.", code: "setup_running" } },
    });
    renderWithProviders(<SetupSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Set up esp32-112233" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Start setup" }));
    expect(await within(dialog).findByText(/Another setup is already running/)).toBeInTheDocument();
  });

  it("shows a failed job with its plain message and a way to try again", async () => {
    routeFetch({
      "GET /api/setup/aps": { body: { ...SUPPORTED, aps: [AP_OPEN] } },
      "GET /api/setup/recovery": { body: NO_MARKER },
      "GET /api/jobs": { body: [] },
      "POST /api/setup/jobs": { status: 201, body: setupJob() },
    });
    openSocket();
    renderWithProviders(<SetupSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Set up esp32-112233" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Start setup" }));
    await screen.findByRole("list", { name: "Steps" });

    push(
      setupJob({
        state: "failed",
        actions: [],
        steps: [{ id: "send_wifi", label: "Send Wi-Fi details", status: "failed" }],
        error: { code: "wifi_auth", message: "The device could not join Home: the Wi-Fi password was wrong", step: "send_wifi" },
        finishedAt: "2026-11-10T09:01:00.000Z",
      }),
    );
    expect(await screen.findByText("The device could not join Home: the Wi-Fi password was wrong")).toBeInTheDocument();
    expect(screen.getByText("Check the Wi-Fi password and try again.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Restore network" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Try again/ }));
    expect(await screen.findByRole("button", { name: "Start setup" })).toBeInTheDocument();
  });

  it("offers Restore network when the PC could not rejoin its Wi-Fi", async () => {
    const calls = routeFetch({
      "GET /api/setup/aps": { body: { ...SUPPORTED, aps: [AP_OPEN] } },
      "GET /api/setup/recovery": { body: NO_MARKER },
      "GET /api/jobs": { body: [] },
      "POST /api/setup/jobs": { status: 201, body: setupJob() },
      "POST /api/setup/recovery/restore": { body: { restored: true, message: "Rejoined Office Wi-Fi." } },
    });
    openSocket();
    renderWithProviders(<SetupSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Set up esp32-112233" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Start setup" }));
    await screen.findByRole("list", { name: "Steps" });
    push(
      setupJob({
        state: "failed",
        actions: [],
        error: { code: "restore_failed", message: "Could not rejoin Office Wi-Fi. Use Restore network.", step: "leave_ap" },
        finishedAt: "2026-11-10T09:01:00.000Z",
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Restore network" }));
    await waitFor(() => expect(posted(calls, "/api/setup/recovery/restore")).toHaveLength(1));
  });

  it("warns prominently when this browser is not on the Manager's PC", async () => {
    routeFetch({ "GET /api/setup/aps": { body: { ...SUPPORTED, aps: [AP_OPEN] } }, "GET /api/setup/recovery": { body: NO_MARKER }, "GET /api/jobs": { body: [] } });
    healthStore.set({ health: { ...HEALTH, lan: true }, ok: true });
    const original = window.location;
    Object.defineProperty(window, "location", { configurable: true, value: { ...original, hostname: "192.168.1.50" } });
    try {
      renderWithProviders(<SetupSection />);
      fireEvent.click(await screen.findByRole("button", { name: "Set up esp32-112233" }));
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByText("You are using the Manager from another computer")).toBeInTheDocument();
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: original });
    }
  });

  it("does not warn when the page is on the Manager's own PC", async () => {
    routeFetch({ "GET /api/setup/aps": { body: { ...SUPPORTED, aps: [AP_OPEN] } }, "GET /api/setup/recovery": { body: NO_MARKER }, "GET /api/jobs": { body: [] } });
    healthStore.set({ health: { ...HEALTH, lan: true }, ok: true });
    renderWithProviders(<SetupSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Set up esp32-112233" }));
    await screen.findByRole("dialog");
    expect(screen.queryByText("You are using the Manager from another computer")).not.toBeInTheDocument();
  });

  it("shows a running setup when Discover is reopened and follows it", async () => {
    routeFetch({
      "GET /api/setup/aps": { body: { ...SUPPORTED, aps: [AP_SECURED] } },
      "GET /api/setup/recovery": { body: NO_MARKER },
      "GET /api/jobs": { body: [waitingJob()] },
    });
    renderWithProviders(<SetupSection />);
    expect(await screen.findByText("A setup is running")).toBeInTheDocument();
    // one setup at a time
    expect(screen.getByRole("button", { name: "Set up esp32-aabbcc" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Show progress" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByRole("form", { name: "Choose the device's network" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });
});

describe("crash recovery banner", () => {
  const marker = { pending: true, marker: { jobId: "old", startedAt: "2026-11-10T08:00:00.000Z", originalSsid: "Office Wi-Fi", profiles: ["de-esp32-setup-1"] } };

  it("offers Restore network and reports the outcome", async () => {
    let state: { pending: boolean; marker: unknown } = marker;
    const calls = routeFetch({
      "GET /api/setup/aps": { body: { ...SUPPORTED, aps: [] } },
      "GET /api/setup/recovery": () => ({ body: state }),
      "GET /api/jobs": { body: [] },
      "POST /api/setup/recovery/restore": () => {
        state = NO_MARKER;
        return { body: { restored: true, message: "Rejoined Office Wi-Fi." } };
      },
    });
    renderWithProviders(<SetupSection />);
    expect(await screen.findByText("An earlier setup did not finish")).toBeInTheDocument();
    expect(screen.getByText("Office Wi-Fi")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Restore network" }));
    expect(await screen.findByText("Rejoined Office Wi-Fi.")).toBeInTheDocument();
    expect(posted(calls, "/api/setup/recovery/restore")).toHaveLength(1);
    await waitFor(() => expect(screen.queryByText("An earlier setup did not finish")).not.toBeInTheDocument());
  });

  it("Dismiss clears the marker", async () => {
    let state: { pending: boolean; marker: unknown } = marker;
    const calls = routeFetch({
      "GET /api/setup/aps": { body: { ...SUPPORTED, aps: [] } },
      "GET /api/setup/recovery": () => ({ body: state }),
      "GET /api/jobs": { body: [] },
      "POST /api/setup/recovery/dismiss": () => {
        state = NO_MARKER;
        return { status: 204 };
      },
    });
    renderWithProviders(<SetupSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(posted(calls, "/api/setup/recovery/dismiss")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText("An earlier setup did not finish")).not.toBeInTheDocument());
  });
});
