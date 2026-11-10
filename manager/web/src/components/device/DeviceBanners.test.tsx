import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetSetupRecovery } from "../../api/setup";
import { resetApiForTests } from "../../api/testing";
import { makeSummary, renderWithProviders, routeFetch } from "../../routes/device/system/testkit";
import { FakeWebSocket } from "../../test/fakes";
import { DeviceBanners } from "./DeviceBanners";

const ADAPTER = { kind: "system", supported: true, reason: null, interfaceName: "Wi-Fi", connectedSsid: "Office", localAddress: "192.168.1.20" };

beforeEach(() => {
  resetApiForTests();
  resetSetupRecovery();
  FakeWebSocket.reset();
  vi.stubGlobal("WebSocket", FakeWebSocket);
});
afterEach(() => {
  resetApiForTests();
  vi.unstubAllGlobals();
});

describe("DeviceBanners recovery entry", () => {
  it("offers 'Recover over its setup Wi-Fi' for an offline device and opens the flow in recover mode", async () => {
    const calls = routeFetch({
      "GET /api/setup/adapter": { body: ADAPTER },
      "GET /api/setup/recovery": { body: { pending: false, marker: null } },
      "GET /api/jobs": { body: [] },
      "POST /api/setup/jobs": { status: 409, body: { error: "This PC cannot join a setup Wi-Fi.", code: "adapter_unsupported" } },
    });
    renderWithProviders(<DeviceBanners summary={makeSummary({ health: "offline" })} />);
    fireEvent.click(await screen.findByRole("button", { name: "Recover over its setup Wi-Fi" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Recover over its setup Wi-Fi" })).toBeInTheDocument();
    expect(within(dialog).getByText(/about a minute without its network/)).toBeInTheDocument();
    expect(within(dialog).getByText(/newer firmware/)).toBeInTheDocument();
    // the Setup AP's security is unknown here, so its password is optional
    fireEvent.click(within(dialog).getByRole("button", { name: "Start setup" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/setup/jobs")).toBe(true));
    expect(calls.find((c) => c.method === "POST" && c.path === "/api/setup/jobs")?.body).toEqual({ ssid: "esp32-b3c4d5", deviceId: "a4cf12b3c4d5" });
    expect(await within(dialog).findByText("This PC cannot join a setup Wi-Fi.")).toBeInTheDocument();
  });

  it("does not offer it when this PC cannot join a setup Wi-Fi", async () => {
    const calls = routeFetch({ "GET /api/setup/adapter": { body: { ...ADAPTER, kind: "none", supported: false, reason: "No Wi-Fi adapter" } } });
    renderWithProviders(<DeviceBanners summary={makeSummary({ health: "unreachable" })} />);
    expect(await screen.findByText(/Can't reach this device/)).toBeInTheDocument();
    await waitFor(() => expect(calls.some((c) => c.path === "/api/setup/adapter")).toBe(true));
    expect(screen.queryByRole("button", { name: "Recover over its setup Wi-Fi" })).not.toBeInTheDocument();
  });

  it("does not ask about setup for an online device", () => {
    const calls = routeFetch({ "GET /api/setup/adapter": { body: ADAPTER } });
    renderWithProviders(<DeviceBanners summary={makeSummary()} />);
    expect(screen.queryByRole("button", { name: "Recover over its setup Wi-Fi" })).not.toBeInTheDocument();
    expect(calls.filter((c) => c.path === "/api/setup/adapter")).toHaveLength(0);
  });
});
