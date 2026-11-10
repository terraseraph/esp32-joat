import type { Job } from "@shared/api";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetFirmware } from "../../../api/firmware";
import { resetApiForTests } from "../../../api/testing";
import { getBrowserWs } from "../../../api/ws";
import { FakeWebSocket } from "../../../test/fakes";
import { makeJob } from "../../../test/jobs";
import { makeFirmwareList, makeImage } from "../../firmware/fixtures";
import { FirmwareCard } from "./FirmwareCard";
import { SystemTab } from "./SystemTab";
import { makeStatus, makeSummary, renderWithProviders, routeFetch, type Call } from "./testkit";

const ID = "a4cf12b3c4d5";
const BASE = `/api/devices/${ID}`;
const TARGET = makeImage({ id: "aaa111", version: "1234567", filename: "runtime-new.bin" });
const OTHER = makeImage({ id: "bbb222", version: "7654321", filename: "runtime-other.bin" });

beforeEach(() => {
  resetApiForTests();
  resetFirmware();
  FakeWebSocket.reset();
  vi.stubGlobal("WebSocket", FakeWebSocket);
});
afterEach(() => {
  resetApiForTests();
  resetFirmware();
  vi.unstubAllGlobals();
});

function setup(extra: Parameters<typeof routeFetch>[0] = {}, ota: Partial<ReturnType<typeof makeStatus>["ota"]> = {}, summary = makeSummary()): Call[] {
  const status = makeStatus();
  status.ota = { ...status.ota, ...ota };
  return routeFetch({
    "GET /api/devices": { body: [summary] },
    "GET /api/jobs": { body: [] },
    "GET /api/firmware": { body: makeFirmwareList({ images: [TARGET, OTHER], targetId: TARGET.id }) },
    [`GET ${BASE}/v1/status`]: { body: status },
    [`GET ${BASE}/v1/ota`]: { body: status.ota },
    ...extra,
  });
}

const job = (over: Partial<Job> = {}): Job =>
  makeJob({
    id: "ota1",
    title: "Update Workshop node",
    deviceIds: [ID],
    steps: [
      { id: "checking", label: "Checking the device", status: "done" },
      { id: "uploading", label: "Sending the new firmware", status: "running", progress: 0.4 },
      { id: "rebooting", label: "Restarting", status: "pending" },
      { id: "verifying", label: "Checking it came back", status: "pending" },
    ],
    devices: [{ deviceId: ID, name: "Workshop node", state: "running", step: "uploading", progress: 0.4 }],
    ...over,
  });

const open = () => {
  getBrowserWs().connect();
  act(() => FakeWebSocket.last().open());
};

describe("Firmware card: update", () => {
  it("opens the sheet with the target preselected, shows from -> to, starts the job and shows the result", async () => {
    const calls = setup({ [`POST ${BASE}/ota`]: { status: 201, body: job() } });
    renderWithProviders(<SystemTab id={ID} />);
    open();
    fireEvent.click(await screen.findByRole("button", { name: /^Update…/ }));
    const sheet = await screen.findByRole("dialog", { name: /Update firmware/ });
    const radios = await within(sheet).findAllByRole("radio");
    expect(radios).toHaveLength(2);
    expect(radios[0]).toBeChecked();
    expect(within(sheet).getByLabelText("What changes")).toHaveTextContent("9dcba89");
    expect(within(sheet).getByLabelText("What changes")).toHaveTextContent("1234567");

    fireEvent.click(radios[1] as HTMLElement);
    expect(within(sheet).getByLabelText("What changes")).toHaveTextContent("7654321");
    fireEvent.click(within(sheet).getByRole("button", { name: "Start update" }));

    await waitFor(() => expect(calls.filter((c) => c.method === "POST" && c.path === `${BASE}/ota`)).toHaveLength(1));
    expect(calls.find((c) => c.path === `${BASE}/ota`)?.body).toEqual({ firmwareId: OTHER.id });
    // live progress
    expect(await within(sheet).findByText("Sending the new firmware")).toBeInTheDocument();
    expect(within(sheet).getByRole("progressbar", { name: "Sending the new firmware progress" })).toHaveAttribute("aria-valuenow", "40");

    act(() =>
      FakeWebSocket.last().emit({
        t: "job",
        job: job({
          state: "succeeded",
          progress: 1,
          actions: [],
          updatedAt: "2026-11-10T09:05:00.000Z",
          finishedAt: "2026-11-10T09:05:00.000Z",
          devices: [{ deviceId: ID, name: "Workshop node", state: "done", result: { fromVersion: "9dcba89", toVersion: "7654321", partition: "ota_1" } }],
        }),
      }),
    );
    expect(await within(sheet).findByText("Update finished")).toBeInTheDocument();
    expect(within(sheet).getByText("7654321", { selector: ".mono" })).toBeInTheDocument();
    fireEvent.click(within(sheet).getAllByRole("button", { name: "Close" }).at(-1) as HTMLElement);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("shows a rolled back update in plain words", async () => {
    setup({ [`POST ${BASE}/ota`]: { status: 201, body: job() } });
    renderWithProviders(<SystemTab id={ID} />);
    open();
    fireEvent.click(await screen.findByRole("button", { name: /^Update…/ }));
    const sheet = await screen.findByRole("dialog");
    fireEvent.click(await within(sheet).findByRole("button", { name: "Start update" }));
    await within(sheet).findByText("Sending the new firmware");
    act(() =>
      FakeWebSocket.last().emit({
        t: "job",
        job: job({
          state: "failed",
          actions: ["retry"],
          updatedAt: "2026-11-10T09:05:00.000Z",
          finishedAt: "2026-11-10T09:05:00.000Z",
          devices: [{ deviceId: ID, name: "Workshop node", state: "rolled_back", message: "The new firmware failed its health check.", result: { fromVersion: "9dcba89" } }],
        }),
      }),
    );
    expect(await within(sheet).findByText("The device went back to its previous firmware")).toBeInTheDocument();
    expect(within(sheet).getAllByText(/The new firmware failed its health check/).length).toBeGreaterThan(0);
  });

  it("shows the Manager's refusal inside the sheet", async () => {
    setup({ [`POST ${BASE}/ota`]: { status: 409, body: { error: "The device is still verifying its last update.", code: "pending_verify" } } });
    renderWithProviders(<SystemTab id={ID} />);
    fireEvent.click(await screen.findByRole("button", { name: /^Update…/ }));
    const sheet = await screen.findByRole("dialog");
    fireEvent.click(await within(sheet).findByRole("button", { name: "Start update" }));
    expect(await within(sheet).findByText("The device is still verifying its last update.")).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "Start update" })).toBeEnabled();
  });

  it("sends the user to the Firmware screen when the library is empty", async () => {
    setup({ "GET /api/firmware": { body: makeFirmwareList() } });
    renderWithProviders(<SystemTab id={ID} />);
    fireEvent.click(await screen.findByRole("button", { name: /^Update…/ }));
    expect(await screen.findByText("No firmware in the library yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Firmware" })).toHaveAttribute("href", "/firmware");
  });

  it("explains a firmware that is still being verified and does not offer an update", async () => {
    setup({}, { image_state: "pending_verify" });
    renderWithProviders(<SystemTab id={ID} />);
    expect(await screen.findByText("This firmware is still being checked")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Update…/ })).toBeDisabled();
  });
});

describe("Firmware card: roll back", () => {
  it("explains what it does, then starts the job and follows it", async () => {
    const calls = setup({
      [`POST ${BASE}/rollback`]: { status: 201, body: job({ id: "rb1", title: "Roll back Workshop node", params: { action: "rollback" }, steps: [] }) },
    });
    renderWithProviders(<SystemTab id={ID} />);
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Roll back…" }));
    const dialog = await screen.findByRole("dialog", { name: "Roll back to the previous firmware?" });
    expect(within(dialog).getByText(/switches back to the firmware it ran before the last update/)).toBeInTheDocument();
    expect(calls.some((c) => c.path === `${BASE}/rollback`)).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Roll back" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "POST" && c.path === `${BASE}/rollback`)).toHaveLength(1));
    expect(await screen.findByRole("dialog", { name: "Rolling back" })).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Roll back Workshop node" })).toBeInTheDocument();
  });

  it("is disabled, with the reason, when the device has no previous firmware", async () => {
    setup({}, { rollback_possible: false });
    renderWithProviders(<SystemTab id={ID} />);
    const btn = await screen.findByRole("button", { name: "Roll back…" });
    expect(btn).toBeDisabled();
    expect(screen.getByText(/Roll back is available after an update/)).toBeInTheDocument();
  });
});

describe("Firmware card: finished jobs", () => {
  it("stops showing a leftover restart report once the job has finished", async () => {
    const calls = setup({}, { session: "rebooting", percent: 100, bytes: 10, total: 10 });
    const status = makeStatus();
    const running = job();
    renderWithProviders(<FirmwareCard id={ID} ota={{ ...status.ota, session: "rebooting", percent: 100, bytes: 10, total: 10 }} progress={null} disabled={false} />);
    open();
    act(() => FakeWebSocket.last().emit({ t: "job", job: running }));
    expect(await screen.findByText("Restarting on the new firmware")).toBeInTheDocument();
    const before = calls.filter((c) => c.path === `${BASE}/v1/ota`).length;
    act(() => FakeWebSocket.last().emit({ t: "job", job: job({ state: "succeeded", progress: 1, actions: [], updatedAt: "2026-11-10T09:05:00.000Z", finishedAt: "2026-11-10T09:05:00.000Z" }) }));
    await waitFor(() => expect(screen.queryByText("Restarting on the new firmware")).not.toBeInTheDocument());
    await waitFor(() => expect(calls.filter((c) => c.path === `${BASE}/v1/ota`).length).toBeGreaterThan(before));
  });

  it("says a rollback result in plain words", async () => {
    setup({ [`POST ${BASE}/rollback`]: { status: 201, body: job({ id: "rb1", title: "Roll back Workshop node", params: { action: "rollback" }, steps: [] }) } });
    renderWithProviders(<SystemTab id={ID} />);
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Roll back…" }));
    const dialog = await screen.findByRole("dialog", { name: "Roll back to the previous firmware?" });
    expect(within(dialog).queryByText(/ota_0|ota_1/)).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Roll back" }));
    const sheet = await screen.findByRole("dialog", { name: "Rolling back" });
    act(() =>
      FakeWebSocket.last().emit({
        t: "job",
        job: job({
          id: "rb1",
          title: "Roll back Workshop node",
          params: { action: "rollback" },
          steps: [],
          state: "succeeded",
          progress: 1,
          actions: [],
          updatedAt: "2026-11-10T09:05:00.000Z",
          finishedAt: "2026-11-10T09:05:00.000Z",
          devices: [{ deviceId: ID, name: "Workshop node", state: "done", result: { fromVersion: "7654321", toVersion: "9dcba89" } }],
        }),
      }),
    );
    expect(await within(sheet).findByText("Rolled back to 9dcba89")).toBeInTheDocument();
    expect(within(sheet).queryByText("Update finished")).not.toBeInTheDocument();
  });
});
