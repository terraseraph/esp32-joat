import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetApiForTests } from "../../../api/testing";
import { ConfirmProvider, ToastProvider } from "../../../components/ui";
import { mockFetch } from "../../../test/fakes";
import { NetworkTab } from "./NetworkTab";

const NETWORK = { state: "sta_connected", sta_ip: "192.168.1.42", ap_ip: "192.168.4.1", ap_ssid: "esp32-b3c4d5", ap_open: true, hostname: "esp32-b3c4d5", rssi: -58, provisioned: true, sta_connected: true };
const MQTT = {
  connected: true, uri: "mqtt://192.168.1.10:1883", reconnects: 1, published: 1840, publish_fail: 0, received: 3, last_error: "",
  root: "devices", prefix: "devices/Workshop_node", topic_id: "Workshop_node", sub: ["system/command"], pub: ["telemetry"],
};
const B = "/api/devices/dev1";

beforeEach(() => resetApiForTests());
afterEach(() => {
  resetApiForTests();
  vi.unstubAllGlobals();
});

function commandBodies(fn: ReturnType<typeof mockFetch>): Record<string, unknown>[] {
  const calls = fn.mock.calls as unknown as [RequestInfo | URL, RequestInit | undefined][];
  return calls
    .filter(([url]) => String(url).endsWith("/command"))
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
}

function setup() {
  const fn = mockFetch({
    [`${B}/v1/network`]: { body: NETWORK },
    [`${B}/v1/mqtt`]: { body: MQTT },
    [`${B}/command`]: { body: { v: 1, ok: true, result: {} } },
  });
  render(
    <MemoryRouter>
      <ToastProvider>
        <ConfirmProvider>
          <NetworkTab id="dev1" />
        </ConfirmProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
  return fn;
}

describe("NetworkTab", () => {
  it("shows Wi-Fi, Setup AP and MQTT from the device", async () => {
    setup();
    expect(await screen.findByText("192.168.1.42")).toBeInTheDocument();
    expect(screen.getByText("esp32-b3c4d5.local")).toBeInTheDocument();
    expect(screen.getByText("Open")).toBeInTheDocument();
    expect(screen.getByText("mqtt://192.168.1.10:1883")).toBeInTheDocument();
    expect(screen.getByText(/Moving to another Wi-Fi network needs newer firmware/)).toBeInTheDocument();
  });

  it("saves only the changed MQTT root, without credentials", async () => {
    const fn = setup();
    fireEvent.click(await screen.findByRole("button", { name: "Configure" }));
    const dlg = await screen.findByRole("dialog");
    fireEvent.change(within(dlg).getByLabelText("Topic root"), { target: { value: "home" } });
    expect(within(dlg).getByText("home/Workshop_node")).toBeInTheDocument();
    fireEvent.click(within(dlg).getByRole("button", { name: "Save and reconnect" }));
    await waitFor(() => expect(commandBodies(fn)).toHaveLength(1));
    expect(commandBodies(fn)[0]).toEqual({ cmd: "mqtt.configure", root: "home" });
  });

  it("sets the Setup AP password", async () => {
    const fn = setup();
    fireEvent.click(await screen.findByRole("button", { name: "Set password" }));
    const dlg = await screen.findByRole("dialog");
    fireEvent.change(within(dlg).getByLabelText("Password"), { target: { value: "hunter2hunter2" } });
    fireEvent.change(within(dlg).getByLabelText("Confirm password"), { target: { value: "hunter2hunter2" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Set password" }));
    await waitFor(() => expect(commandBodies(fn)).toHaveLength(1));
    expect(commandBodies(fn)[0]).toEqual({ cmd: "network.ap.set_password", password: "hunter2hunter2" });
  });
});
