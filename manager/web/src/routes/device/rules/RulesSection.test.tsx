import type { LiveIoMap } from "@shared/api";
import type { Rule } from "@shared/device-api";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MotionConfig } from "motion/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedLiveIo } from "../../../api/live";
import { resetApiForTests } from "../../../api/testing";
import { ConfirmProvider, ToastProvider, TooltipProvider } from "../../../components/ui";
import { FakeWebSocket } from "../../../test/fakes";
import { RulesSection } from "./RulesSection";

const io = {
  gpio_4: { id: "gpio_4", mode: "out", gpio: 4, level: 0 },
  gpio_27: { id: "gpio_27", mode: "in", gpio: 27, level: 1 },
  adc_32: { id: "adc_32", mode: "adc", gpio: 32, mv: 1650, raw: 2000, sample_ms: 100, hysteresis_mv: 0, smooth: 0 },
  pwm_18: { id: "pwm_18", mode: "pwm", gpio: 18, hz: 1000, duty: 250 },
} as unknown as LiveIoMap;

const r32: Rule = { id: "r32", enabled: true, on: { gpio: 32, op: "gt", value: 1000 }, then: { gpio: 4, value: 1 }, else: { gpio: 4, value: 0 } };

interface Sent {
  cmd: string;
  [k: string]: unknown;
}

function stubFetch(handle: (body: Sent) => { ok: true; result: unknown } | { ok: false; error: string }) {
  const sent: Sent[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).split("?")[0] ?? "";
      if (path === "/api/devices/dev1/command") {
        const body = JSON.parse(String(init?.body)) as Sent;
        sent.push(body);
        return new Response(JSON.stringify({ v: 1, ...handle(body) }));
      }
      if (path === "/api/devices") return new Response("[]");
      return new Response(JSON.stringify({ error: "Not found", code: "not_found" }), { status: 404 });
    }),
  );
  return { sent };
}

function mount() {
  seedLiveIo("dev1", io);
  return render(
    <MotionConfig reducedMotion="always">
      <TooltipProvider>
        <ToastProvider>
          <ConfirmProvider>
            <RulesSection id="dev1" />
          </ConfirmProvider>
        </ToastProvider>
      </TooltipProvider>
    </MotionConfig>,
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

describe("RulesSection", () => {
  it("lists rules in plain words with the used count", async () => {
    stubFetch(() => ({ ok: true, result: { v: 1, rules: [r32] } }));
    mount();
    expect(await screen.findByRole("heading", { name: "Rules · 1 / 8 used" })).toBeInTheDocument();
    expect(await screen.findByText(/When/)).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Rules" });
    expect(list).toHaveTextContent("When GPIO 32 (Analog) > 1000 mV then GPIO 4 = 1, otherwise GPIO 4 = 0");
  });

  it("adds a rule through the sheet (rule.set) and reloads the list", async () => {
    let rules: Rule[] = [r32];
    const { sent } = stubFetch((b) => {
      if (b.cmd === "rule.list") return { ok: true, result: { v: 1, rules } };
      if (b.cmd === "rule.set") {
        rules = [...rules, { id: "r27", enabled: true, on: { gpio: 27, op: "eq", value: 1 }, then: { gpio: 4, value: 1 } }];
        return { ok: true, result: { v: 1, rules } };
      }
      return { ok: false, error: "unexpected" };
    });
    mount();
    await screen.findByRole("list", { name: "Rules" });
    fireEvent.click(screen.getByRole("button", { name: /Add rule/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Source pin"), { target: { value: "27" } });
    fireEvent.change(within(dialog).getByLabelText("Is"), { target: { value: "eq" } });
    fireEvent.change(within(dialog).getByLabelText("Destination pin"), { target: { value: "4" } });
    expect(within(dialog).getByLabelText("Rule ID")).toHaveAttribute("placeholder", "r27");
    expect(within(dialog).getByText(/max 7 characters/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save rule" }));
    await waitFor(() => expect(sent.find((s) => s.cmd === "rule.set")).toBeDefined());
    expect(sent.find((s) => s.cmd === "rule.set")).toEqual({
      cmd: "rule.set",
      rule: { id: "r27", enabled: true, on: { gpio: 27, op: "eq", value: 1 }, then: { gpio: 4, value: 1 } },
    });
    expect(await screen.findByRole("heading", { name: "Rules · 2 / 8 used" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("warns that saving replaces the rule on the same source and shows device errors verbatim", async () => {
    stubFetch((b) => (b.cmd === "rule.list" ? { ok: true, result: { v: 1, rules: [r32] } } : { ok: false, error: "too many rules (max 8)" }));
    mount();
    await screen.findByRole("list", { name: "Rules" });
    fireEvent.click(screen.getByRole("button", { name: /Add rule/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Source pin"), { target: { value: "32" } });
    expect(within(dialog).getByText("This replaces rule r32 for GPIO 32.")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save rule" }));
    expect(await within(dialog).findByText("too many rules (max 8)")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("toggles enabled with the whole rule and deletes after confirming", async () => {
    let rules: Rule[] = [r32];
    const { sent } = stubFetch((b) => {
      if (b.cmd === "rule.remove") rules = [];
      return { ok: true, result: { v: 1, rules } };
    });
    mount();
    await screen.findByRole("list", { name: "Rules" });
    fireEvent.click(screen.getByRole("switch", { name: "Enable rule r32" }));
    await waitFor(() => expect(sent).toContainEqual({ cmd: "rule.set", rule: { ...r32, enabled: false } }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const confirmDialog = await screen.findByRole("dialog");
    fireEvent.click(within(confirmDialog).getByRole("button", { name: "Delete rule" }));
    await waitFor(() => expect(sent).toContainEqual({ cmd: "rule.remove", id: "r32" }));
    expect(await screen.findByText("No rules yet")).toBeInTheDocument();
  });

  it("disables Add when all 8 slots are used but still lets you edit", async () => {
    const eight: Rule[] = Array.from({ length: 8 }, (_, i) => ({ id: `r${i}`, enabled: true, on: { gpio: i === 0 ? 32 : 100 + i, op: "gt", value: 1 }, then: { gpio: 4, value: 1 } }) as Rule);
    stubFetch(() => ({ ok: true, result: { v: 1, rules: eight } }));
    mount();
    expect(await screen.findByRole("heading", { name: "Rules · 8 / 8 used" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Add rule/ })).toBeDisabled();
    expect(screen.getByText(/All 8 rule slots are used/)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]!);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Edit rule r0")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Save rule" })).toBeEnabled();
  });

  it("shows the device error with Retry when the list cannot be loaded", async () => {
    stubFetch(() => ({ ok: false, error: "rule engine busy" }));
    mount();
    expect(await screen.findByText("rule engine busy")).toBeInTheDocument();
    await act(async () => {});
    expect(screen.getByRole("button", { name: /Retry/ })).toBeInTheDocument();
  });
});
