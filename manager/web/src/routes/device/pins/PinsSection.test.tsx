import type { PinConfigResponse } from "@shared/api";
import type { Hardware, HardwarePin } from "@shared/device-api";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetApiForTests } from "../../../api/testing";
import { ConfirmProvider } from "../../../components/ui/ConfirmDialog";
import { ToastProvider } from "../../../components/ui/Toast";
import { TooltipProvider } from "../../../components/ui/Tooltip";
import { FakeWebSocket } from "../../../test/fakes";
import { PinsSection } from "./PinsSection";

const pin = (gpio: number, over: Partial<HardwarePin> = {}): HardwarePin => ({
  gpio, input: true, output: true, pull: true, pwm: true, adc1: false, adc2: false, touch: false, dac: false, strap: false, flash: false,
  input_only: false, status_led: false, boot_btn: false, adc_channel: 0, touch_channel: 0, role: "", notes: "general I/O", owner: "", ...over,
});

const HARDWARE: Hardware = {
  board_id: "esp32-devkitc",
  board_name: "DevKitC",
  status_led_gpio: 2,
  status_led_active_high: true,
  boot_gpio: 0,
  header: {
    usb: "USB",
    left: [
      { i: 0, silk: "3V3", gpio: null, kind: "power" },
      { i: 1, silk: "25", gpio: 25, kind: "gpio" },
      { i: 2, silk: "34", gpio: 34, kind: "gpio" },
    ],
    right: [
      { i: 0, silk: "GND", gpio: null, kind: "gnd" },
      { i: 1, silk: "4", gpio: 4, kind: "gpio" },
      { i: 2, silk: "CLK", gpio: 6, kind: "gpio" },
    ],
  },
  buses: [],
  chip: "ESP32 rev3",
  chip_info: { model: "ESP32", revision: 3, cores: 2, features: ["wifi"] },
  pins: [
    pin(25, { adc2: true, dac: true, notes: "DAC1 / ADC2" }),
    pin(34, { output: false, pull: false, pwm: false, input_only: true, adc1: true, notes: "input-only" }),
    pin(4, { adc2: true, owner: "mod_env0" }),
    pin(6, { flash: true, input: false, output: false, pwm: false, pull: false, notes: "SPI flash" }),
  ],
};
const PIN_CONFIG: PinConfigResponse = { pins: [] };

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function stubFetch(over: { commandError?: string } = {}) {
  const calls: Call[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input).split("?")[0] ?? "";
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ url, method: init?.method ?? "GET", body });
      if (url === "/api/devices/d1/v1/hardware") return json(HARDWARE);
      if (url === "/api/devices/d1/pin-config") return json(PIN_CONFIG);
      if (url === "/api/devices/d1/command") {
        const cmd = (body as { cmd?: string } | undefined)?.cmd;
        if (cmd === "rule.list") return json({ v: 1, ok: true, result: { v: 1, rules: [] } });
        if (cmd === "pin.configure") {
          if (over.commandError) return json({ v: 1, ok: false, error: over.commandError });
          return json({ v: 1, ok: true, result: (body as { pin: unknown }).pin });
        }
      }
      return json({ error: "Not found", code: "not_found" }, 404);
    }),
  );
  return calls;
}

function renderSection() {
  return render(
    <TooltipProvider>
      <ToastProvider>
        <ConfirmProvider>
          <PinsSection id="d1" />
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

const commandCalls = (calls: Call[]) => calls.filter((c) => c.url === "/api/devices/d1/command" && (c.body as { cmd?: string }).cmd === "pin.configure");

describe("PinsSection", () => {
  it("shows the pinout, marks flash pins unclickable and add-on pins as in use", async () => {
    stubFetch();
    renderSection();
    const free = await screen.findByRole("button", { name: /^GPIO 25, free/ });
    expect(free).toBeEnabled();
    expect(screen.getByRole("button", { name: /^GPIO 6 \(CLK\), reserved for SPI flash/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^GPIO 4, in use by add-on env0/ })).toBeEnabled();
    expect(screen.getByText(/0 configured · 1 used by add-ons · 2 free/)).toBeInTheDocument();
  });

  it("configures a pin: click the pad, choose PWM, save sends the minimal pin.configure", async () => {
    const calls = stubFetch();
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: /^GPIO 25,/ }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("GPIO 25");
    // ADC2 pin: Analog is listed but disabled.
    expect(screen.getByRole("radio", { name: "Analog" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("radio", { name: "PWM" }));
    fireEvent.change(screen.getByLabelText(/Frequency \(shared by all PWM pins\)/), { target: { value: "5000" } });
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));

    await waitFor(() => expect(commandCalls(calls)).toHaveLength(1));
    expect(commandCalls(calls)[0]).toMatchObject({ method: "POST", body: { cmd: "pin.configure", pin: { gpio: 25, mode: "pwm", hz: 5000 } } });
    expect(commandCalls(calls)[0]?.body).toEqual({ cmd: "pin.configure", pin: { gpio: 25, mode: "pwm", hz: 5000 } });
    // success: sheet closes, toast, hardware + pin-config reload
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByText("GPIO 25 set to PWM")).toBeInTheDocument();
    await waitFor(() => expect(calls.filter((c) => c.url === "/api/devices/d1/v1/hardware").length).toBeGreaterThanOrEqual(2));
    expect(calls.filter((c) => c.url === "/api/devices/d1/pin-config").length).toBeGreaterThanOrEqual(2);
  });

  it("limits an input-only pin to Off / Input / Analog", async () => {
    stubFetch();
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: /^GPIO 34,/ }));
    await screen.findByRole("dialog");
    expect(screen.getAllByRole("radio").map((r) => r.textContent)).toEqual(["Off", "Input", "Analog"]);
  });

  it("shows the device error verbatim and keeps the sheet open", async () => {
    stubFetch({ commandError: "gpio 25 is busy" });
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: /^GPIO 25,/ }));
    fireEvent.click(await screen.findByRole("radio", { name: "Output" }));
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));
    expect(await screen.findByText("gpio 25 is busy")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("explains a pin owned by an add-on instead of offering modes", async () => {
    stubFetch();
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: /^GPIO 4,/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Used by add-on env0")).toBeInTheDocument();
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Go to add-ons" })).toBeInTheDocument();
  });
});
