import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MotionConfig } from "motion/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetApiForTests } from "../../../api/testing";
import { ConfirmProvider, ToastProvider, TooltipProvider } from "../../../components/ui";
import { FakeWebSocket } from "../../../test/fakes";
import { CATALOG, ENV0, makeHardware } from "./addonFixtures";
import { AddonsSection } from "./AddonsSection";

interface Sent {
  cmd: string;
  [k: string]: unknown;
}

/** fetch double: `/command` is answered by `handle`, `v1/hardware` and `/api/devices` with fixed JSON. */
function stubFetch(handle: (body: Sent) => { ok: true; result: unknown } | { ok: false; error: string }) {
  const sent: Sent[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).split("?")[0] ?? "";
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (path === "/api/devices/dev1/command") {
      const body = JSON.parse(String(init?.body)) as Sent;
      sent.push(body);
      return json({ v: 1, ...handle(body) });
    }
    if (path === "/api/devices/dev1/v1/hardware") return json(makeHardware());
    if (path === "/api/devices") return json([]);
    return json({ error: "Not found", code: "not_found" }, 404);
  });
  vi.stubGlobal("fetch", fn);
  return { sent };
}

function mount() {
  return render(
    <MotionConfig reducedMotion="always">
      <TooltipProvider>
        <ToastProvider>
          <ConfirmProvider>
            <AddonsSection id="dev1" />
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

async function walkWizardToReview() {
  fireEvent.click((await screen.findAllByRole("button", { name: /Add add-on/ }))[0]!);
  const dialog = await screen.findByRole("dialog");
  // step 1: BME280 is pre-selected
  expect(within(dialog).getByRole("button", { name: /BME280/ })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(within(dialog).getByRole("button", { name: "Next" }));
  expect(await within(dialog).findByLabelText(/Name/)).toHaveValue("env0");
  fireEvent.click(within(dialog).getByRole("button", { name: "Next" }));
  expect(await within(dialog).findByLabelText("I2C address")).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole("button", { name: "Next" }));
  await within(dialog).findByText(/enough free memory/);
  return dialog;
}

describe("AddonsSection", () => {
  it("shows the empty state and adds a BME280 through the wizard (module.add)", async () => {
    let modules: unknown[] = [];
    const { sent } = stubFetch((b) => {
      if (b.cmd === "module.catalog") return { ok: true, result: CATALOG };
      if (b.cmd === "module.list") return { ok: true, result: { v: 1, modules } };
      if (b.cmd === "module.add") {
        modules = [ENV0];
        return { ok: true, result: { v: 1, modules } };
      }
      return { ok: false, error: "unexpected" };
    });
    mount();
    expect(await screen.findByText("No add-ons yet")).toBeInTheDocument();
    const dialog = await walkWizardToReview();
    fireEvent.click(within(dialog).getByRole("button", { name: "Add add-on" }));
    await waitFor(() => expect(sent.find((s) => s.cmd === "module.add")).toBeDefined());
    expect(sent.find((s) => s.cmd === "module.add")).toEqual({
      cmd: "module.add", type: "bme280", id: "env0", bus: "i2c0", pins: { sda: 21, scl: 22 }, settings: { addr: 118, sample_ms: 1000, mode: "normal" },
    });
    // the list reloads and the new card shows its live reading
    expect(await screen.findByLabelText("Add-on env0")).toHaveTextContent("23.4 °C");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("shows device errors verbatim in the sheet and keeps it open", async () => {
    stubFetch((b) => {
      if (b.cmd === "module.catalog") return { ok: true, result: CATALOG };
      if (b.cmd === "module.list") return { ok: true, result: { v: 1, modules: [] } };
      return { ok: false, error: "need 6144 bytes, largest 4096, free 30000" };
    });
    mount();
    await screen.findByText("No add-ons yet");
    const dialog = await walkWizardToReview();
    fireEvent.click(within(dialog).getByRole("button", { name: "Add add-on" }));
    expect(await within(dialog).findByText("need 6144 bytes, largest 4096, free 30000")).toBeInTheDocument();
    expect(within(dialog).getByText(/Reboot the device or remove another add-on/)).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("toggles enabled with module.configure and removes after confirming", async () => {
    let modules: unknown[] = [ENV0];
    const { sent } = stubFetch((b) => {
      if (b.cmd === "module.catalog") return { ok: true, result: CATALOG };
      if (b.cmd === "module.list") return { ok: true, result: { v: 1, modules } };
      if (b.cmd === "module.configure") return { ok: true, result: { v: 1, modules } };
      if (b.cmd === "module.remove") {
        modules = [];
        return { ok: true, result: { v: 1, modules } };
      }
      return { ok: false, error: "unexpected" };
    });
    mount();
    const card = await screen.findByLabelText("Add-on env0");
    expect(card).toHaveTextContent("SDA 21 · SCL 22");
    fireEvent.click(within(card).getByRole("switch", { name: "Enable env0" }));
    await waitFor(() => expect(sent).toContainEqual({ cmd: "module.configure", id: "env0", enabled: false }));
    fireEvent.click(within(card).getByRole("button", { name: "Remove" }));
    const confirmDialog = await screen.findByRole("dialog");
    fireEvent.click(within(confirmDialog).getByRole("button", { name: "Remove add-on" }));
    await waitFor(() => expect(sent).toContainEqual({ cmd: "module.remove", id: "env0" }));
    expect(await screen.findByText("No add-ons yet")).toBeInTheDocument();
  });

  it("shows the device error with Retry when the list cannot be loaded", async () => {
    stubFetch((b) => (b.cmd === "module.catalog" ? { ok: true, result: CATALOG } : { ok: false, error: "memory pressure" }));
    mount();
    expect(await screen.findByText("memory pressure")).toBeInTheDocument();
    await act(async () => {});
    expect(screen.getByRole("button", { name: /Retry/ })).toBeInTheDocument();
  });
});
