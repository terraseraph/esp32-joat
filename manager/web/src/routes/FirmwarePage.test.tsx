import type { Job } from "@shared/api";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetFirmware } from "../api/firmware";
import { resetApiForTests } from "../api/testing";
import { getBrowserWs } from "../api/ws";
import { FakeWebSocket } from "../test/fakes";
import { makeJob } from "../test/jobs";
import { FakeXhr } from "../test/xhr";
import { renderWithProviders, routeFetch, type Call } from "./device/system/testkit";
import { makeDevice } from "./fleet/fixtures";
import { makeFirmwareList, makeImage } from "./firmware/fixtures";
import { FirmwarePage } from "./FirmwarePage";

const NEW = makeImage({ id: "aaa111", version: "9dcba89", filename: "runtime-new.bin" });
const OLD = makeImage({ id: "bbb222", version: "0de951c", filename: "runtime-old.bin", date: "Nov 8 2026", source: "latest" });

const GARAGE = makeDevice({ id: "3c71bf0a9e11", name: "Garage door", fwMatchesTarget: false, app_version: "0de951c" });
const KITCHEN = makeDevice({ id: "246f28c0ffee", name: "Kitchen relay", fwMatchesTarget: false, app_version: "5e3c76f", health: "offline" });
const WORKSHOP = makeDevice({ id: "a4cf12b3c4d5", name: "Workshop node", fwMatchesTarget: true });
const VERIFYING = makeDevice({
  id: "9a3b6c000000",
  name: "Verifying one",
  fwMatchesTarget: false,
  ota: { running_partition: "ota_1", image_state: "pending_verify", rollback_possible: true, busy: false },
});

beforeEach(() => {
  resetApiForTests();
  resetFirmware();
  FakeWebSocket.reset();
  FakeXhr.reset();
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
});
afterEach(() => {
  resetApiForTests();
  resetFirmware();
  vi.unstubAllGlobals();
});

function server(extra: Parameters<typeof routeFetch>[0] = {}, devices = [GARAGE, KITCHEN, WORKSHOP, VERIFYING], list = makeFirmwareList({ images: [NEW, OLD], targetId: NEW.id })): Call[] {
  return routeFetch({
    "GET /api/firmware": { body: list },
    "GET /api/devices": { body: devices },
    "GET /api/jobs": { body: [] },
    ...extra,
  });
}

const posts = (calls: Call[], path: string) => calls.filter((c) => c.method === "POST" && c.path === path);

describe("FirmwarePage library", () => {
  it("explains an empty library and an empty fleet", async () => {
    server({}, [], makeFirmwareList());
    renderWithProviders(<FirmwarePage />, "/firmware");
    expect(await screen.findByText(/No firmware yet/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Get latest" })).toBeEnabled();
    expect(await screen.findByText("No devices in your fleet yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose a target firmware first" })).toBeDisabled();
  });

  it("lists the images with their metadata and the target, and changes the target with PUT", async () => {
    const calls = server({
      "PUT /api/firmware/target": (c) => ({ body: makeFirmwareList({ images: [NEW, OLD], targetId: (c.body as { firmwareId: string }).firmwareId }) }),
    });
    renderWithProviders(<FirmwarePage />, "/firmware");
    const radios = await screen.findAllByRole("radio");
    expect(radios).toHaveLength(2);
    expect(radios[0]).toBeChecked();
    expect(screen.getByText("Target")).toBeInTheDocument();
    expect(screen.getAllByText("de_esp32_runtime")).toHaveLength(2);
    expect(screen.getAllByText(/ESP-IDF v5.4.2/)).toHaveLength(2);
    expect(screen.getByText(/Built Nov 8 2026 09:12/)).toBeInTheDocument();
    expect(screen.getByText(/Downloaded/)).toBeInTheDocument();
    // 3 of the 4 devices differ
    expect(await screen.findByText("3 of 4 devices differ from 9dcba89.")).toBeInTheDocument();

    fireEvent.click(radios[1] as HTMLElement);
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1));
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ firmwareId: OLD.id });
    await waitFor(() => expect(screen.getAllByRole("radio")[1]).toBeChecked());
  });

  it("shows why the latest build could not be fetched and keeps uploaded images usable", async () => {
    server({ "POST /api/firmware/latest": { status: 502, body: { error: "Couldn't reach terraseraph.github.io. Check this PC's internet connection.", code: "fetch_failed" } } });
    renderWithProviders(<FirmwarePage />, "/firmware");
    fireEvent.click(await screen.findByRole("button", { name: "Get latest" }));
    expect(await screen.findByText(/Couldn't reach terraseraph.github.io/)).toBeInTheDocument();
    expect(screen.getByText(/Uploaded images are still usable/)).toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(2);
  });

  it("shows the server's last latest-check error and time", async () => {
    server({}, [WORKSHOP], makeFirmwareList({ images: [NEW], targetId: NEW.id, latest: { baseUrl: "https://example.test/", checkedAt: new Date().toISOString(), imageId: NEW.id, error: "It answered 404." } }));
    renderWithProviders(<FirmwarePage />, "/firmware");
    expect(await screen.findByText(/It answered 404/)).toBeInTheDocument();
    expect(screen.getByText("example.test/firmware/de_esp32_runtime.bin")).toBeInTheDocument();
    expect(screen.getByText(/Checked just now/)).toBeInTheDocument();
    expect(screen.getByText("Latest CI build")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check again" })).toBeInTheDocument();
  });

  it("uploads with progress, shows the plain reason when an image is rejected, and adds an accepted one", async () => {
    server();
    renderWithProviders(<FirmwarePage />, "/firmware");
    const zone = await screen.findByLabelText("Choose a firmware .bin file");
    await screen.findAllByRole("radio");
    const bad = new File([new Uint8Array(8)], "notes.bin");
    fireEvent.change(zone, { target: { files: [bad] } });
    const xhr = FakeXhr.last();
    expect(xhr.method).toBe("POST");
    expect(xhr.url).toBe("/api/firmware");
    expect(xhr.headers["X-Filename"]).toBe("notes.bin");
    expect(xhr.headers["Content-Type"]).toBe("application/octet-stream");
    act(() => xhr.progress(4, 8));
    expect(screen.getByRole("progressbar", { name: "Uploading notes.bin" })).toHaveAttribute("aria-valuenow", "50");
    act(() => xhr.respond(422, { error: "Not an ESP32 app image (bad magic)", code: "invalid_image" }));
    expect(await screen.findByText("Not an ESP32 app image (bad magic)")).toBeInTheDocument();
    expect(zone).toHaveAttribute("aria-invalid", "true");

    const good = new File([new Uint8Array(8)], "runtime-3.bin");
    fireEvent.change(zone, { target: { files: [good] } });
    act(() => FakeXhr.last().respond(201, makeImage({ id: "ccc333", version: "3333333", filename: "runtime-3.bin" })));
    expect(await screen.findByText("Added firmware 3333333")).toBeInTheDocument();
    expect(screen.queryByText("Not an ESP32 app image (bad magic)")).not.toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(3);
  });
});

describe("FirmwarePage devices", () => {
  it("compares the fleet with the target, explains who cannot be updated and ticks the devices that differ", async () => {
    server();
    renderWithProviders(<FirmwarePage />, "/firmware");
    const table = await screen.findByRole("table");
    const row = (name: string) => within(table).getByText(name).closest("tr") as HTMLElement;
    expect(within(row("Garage door")).getByText("Ready to update")).toBeInTheDocument();
    expect(within(row("Kitchen relay")).getByText("Offline, can't update")).toBeInTheDocument();
    expect(within(row("Verifying one")).getByText("Still verifying its last update")).toBeInTheDocument();
    expect(within(row("Workshop node")).getByText(/Up to date · select to reinstall/)).toBeInTheDocument();
    expect(within(row("Kitchen relay")).getByRole("checkbox")).toBeDisabled();
    expect(within(row("Garage door")).getByRole("checkbox")).toBeChecked();
    expect(within(row("Workshop node")).getByRole("checkbox")).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Update 1 device" })).toBeEnabled();

    // filters
    fireEvent.click(screen.getByRole("button", { name: /Can't update/ }));
    expect(within(table).queryByText("Garage door")).not.toBeInTheDocument();
    expect(within(table).getByText("Kitchen relay")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Up to date/ }));
    expect(within(table).getByText("Workshop node")).toBeInTheDocument();
    expect(within(table).queryByText("Kitchen relay")).not.toBeInTheDocument();
  });

  it("preselects the devices the Fleet bulk bar sent (reinstalling one that is up to date)", async () => {
    server();
    renderWithProviders(<FirmwarePage />, `/firmware?devices=${GARAGE.id},${WORKSHOP.id},${KITCHEN.id}`);
    // the offline one is dropped, the other two stay ticked
    expect(await screen.findByRole("button", { name: "Update 2 devices" })).toBeEnabled();
  });
});

const jobFor = (over: Partial<Job> = {}): Job =>
  makeJob({
    id: "job1",
    title: "Update 2 devices to 9dcba89",
    deviceIds: [GARAGE.id, WORKSHOP.id],
    devices: [
      { deviceId: GARAGE.id, name: "Garage door", state: "running", step: "uploading", progress: 0.64, message: "Sending the new firmware" },
      { deviceId: WORKSHOP.id, name: "Workshop node", state: "queued" },
    ],
    actions: ["pause", "cancel"],
    ...over,
  });

describe("FirmwarePage parallel updates", () => {
  it("starts from the defaultParallelUpdates setting, shows it in the confirm dialog and sends it", async () => {
    const calls = server({ "GET /api/settings": { body: { defaultParallelUpdates: 4 } }, "POST /api/firmware/update": { status: 201, body: makeJob({ id: "j9", title: "Update 2 devices to 9dcba89" }) } });
    renderWithProviders(<FirmwarePage />, `/firmware?devices=${GARAGE.id},${WORKSHOP.id}`);
    await waitFor(() => expect(screen.getByLabelText("Parallel updates")).toHaveValue("4"));
    fireEvent.click(await screen.findByRole("button", { name: "Update 2 devices" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Parallel updates")).toBeInTheDocument();
    expect(within(dialog).getByTestId("confirm-parallel")).toHaveTextContent("2 (limit 4, fewer devices)");
    fireEvent.click(within(dialog).getByRole("button", { name: "Update 2 devices" }));
    await waitFor(() => expect(posts(calls, "/api/firmware/update")).toHaveLength(1));
    expect((posts(calls, "/api/firmware/update")[0]?.body as { concurrency: number }).concurrency).toBe(4);
  });

  it("uses 2 when the setting cannot be read, and a number the user picks wins", async () => {
    server();
    renderWithProviders(<FirmwarePage />, `/firmware?devices=${GARAGE.id},${WORKSHOP.id}`);
    await waitFor(() => expect(screen.getByLabelText("Parallel updates")).toHaveValue("2"));
    fireEvent.change(screen.getByLabelText("Parallel updates"), { target: { value: "1" } });
    fireEvent.click(await screen.findByRole("button", { name: "Update 2 devices" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByTestId("confirm-parallel")).toHaveTextContent("1");
  });
});

describe("FirmwarePage bulk update", () => {
  it("confirms, starts the job with the chosen options and follows it: pause on failure, resume, retry", async () => {
    const calls = server({
      "POST /api/firmware/update": { status: 201, body: jobFor() },
      "POST /api/jobs/job1/resume": { body: jobFor({ state: "running", updatedAt: "2026-11-10T09:05:00.000Z" }) },
      "POST /api/jobs/job1/retry": {
        body: jobFor({
          id: "job2",
          title: "Retry of job1",
          createdAt: "2026-11-10T09:10:00.000Z",
          updatedAt: "2026-11-10T09:10:00.000Z",
          devices: [{ deviceId: WORKSHOP.id, name: "Workshop node", state: "queued" }],
        }),
      },
    });
    renderWithProviders(<FirmwarePage />, `/firmware?devices=${GARAGE.id},${WORKSHOP.id}`);
    getBrowserWs().connect();
    act(() => FakeWebSocket.last().open());

    fireEvent.change(await screen.findByLabelText("Parallel updates"), { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText("When something goes wrong"), { target: { value: "2" } });
    fireEvent.click(await screen.findByRole("button", { name: "Update 2 devices" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("1 device already runs 9dcba89 and will be reinstalled.")).toBeInTheDocument();
    expect(within(dialog).getByText("0de951c → 9dcba89")).toBeInTheDocument();
    expect(posts(calls, "/api/firmware/update")).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Update 2 devices" }));

    await waitFor(() => expect(posts(calls, "/api/firmware/update")).toHaveLength(1));
    expect(posts(calls, "/api/firmware/update")[0]?.body).toEqual({ deviceIds: [GARAGE.id, WORKSHOP.id], firmwareId: NEW.id, concurrency: 3, stopOnFailures: 2, skipSame: false });

    const panel = await screen.findByRole("region", { name: "Update 2 devices to 9dcba89" });
    expect(within(panel).getByText("Sending the new firmware")).toBeInTheDocument();
    expect(within(panel).getByRole("progressbar", { name: "Garage door progress" })).toHaveAttribute("aria-valuenow", "64");
    expect(screen.getByText("1 in progress · 1 waiting")).toBeInTheDocument();

    // a failure pauses the job
    act(() =>
      FakeWebSocket.last().emit({
        t: "job",
        job: jobFor({
          state: "paused",
          message: "Paused after 1 failure.",
          actions: ["resume", "cancel"],
          updatedAt: "2026-11-10T09:02:00.000Z",
          devices: [
            { deviceId: GARAGE.id, name: "Garage door", state: "failed", error: { code: "upload_failed", message: "The upload was interrupted. The device still runs 0de951c." } },
            { deviceId: WORKSHOP.id, name: "Workshop node", state: "queued" },
          ],
        }),
      }),
    );
    expect(await screen.findByText("Paused after 1 failure.")).toBeInTheDocument();
    expect(screen.getByText("The upload was interrupted. The device still runs 0de951c.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(posts(calls, "/api/jobs/job1/resume")).toHaveLength(1));

    // it finishes with a failure; Retry follows the new job
    act(() =>
      FakeWebSocket.last().emit({
        t: "job",
        job: jobFor({
          state: "partial",
          progress: 1,
          actions: ["retry"],
          finishedAt: "2026-11-10T09:08:00.000Z",
          updatedAt: "2026-11-10T09:08:00.000Z",
          devices: [
            { deviceId: GARAGE.id, name: "Garage door", state: "failed", message: "Failed at Uploading" },
            { deviceId: WORKSHOP.id, name: "Workshop node", state: "done" },
          ],
        }),
      }),
    );
    expect(await screen.findByText("Last update")).toBeInTheDocument();
    expect(screen.getByText("1 updated · 1 failed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(posts(calls, "/api/jobs/job1/retry")).toHaveLength(1));
    expect(await screen.findByRole("region", { name: "Retry of job1" })).toBeInTheDocument();
  });

  it("shows the Manager's refusal in the confirm dialog and keeps it open", async () => {
    server({ "POST /api/firmware/update": { status: 409, body: { error: "Some of those devices are already being updated.", code: "ota_running" } } });
    renderWithProviders(<FirmwarePage />, "/firmware");
    fireEvent.click(await screen.findByRole("button", { name: "Update 1 device" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Update 1 device" }));
    expect(await within(dialog).findByText("Some of those devices are already being updated.")).toBeInTheDocument();
  });

  it("picks up an update that was started elsewhere and lists finished ones in the history", async () => {
    server({
      "GET /api/jobs": {
        body: [
          jobFor(),
          makeJob({ id: "old", title: "Update Bench node to 0de951c", state: "succeeded", actions: [], deviceIds: [WORKSHOP.id], finishedAt: "2026-11-09T09:00:00.000Z" }),
        ],
      },
    });
    renderWithProviders(<FirmwarePage />, "/firmware");
    expect(await screen.findByText("Update in progress")).toBeInTheDocument();
    expect(screen.getByText("History")).toBeInTheDocument();
    expect(screen.getByText("Update Bench node to 0de951c")).toBeInTheDocument();
    // the devices that are in the running job cannot be picked again
    expect(await screen.findAllByText("Already being updated")).not.toHaveLength(0);
  });
});

function Where() {
  const l = useLocation();
  return <output data-testid="where">{l.pathname + l.search}</output>;
}

describe("FirmwarePage selection and confirm", () => {
  const MANY = ["d1", "d2", "d3", "d4", "d5", "d6"].map((id) => makeDevice({ id, name: "Board " + id, fwMatchesTarget: false, app_version: "0de951c" }));

  it("never widens the selection or reopens a confirm after a one-device job starts", async () => {
    const calls = server({ "POST /api/firmware/update": { status: 201, body: jobFor({ deviceIds: ["d1"], devices: [{ deviceId: "d1", name: "Board d1", state: "running", progress: 0.1 }] }) } }, MANY);
    renderWithProviders(
      <>
        <FirmwarePage />
        <Where />
      </>,
      "/firmware?devices=d1,d2,d3,d4,d5,d6",
    );
    expect(await screen.findByRole("button", { name: "Update 6 devices" })).toBeEnabled();
    for (const id of ["d2", "d3", "d4", "d5", "d6"]) fireEvent.click(screen.getByRole("checkbox", { name: "Select Board " + id }));
    expect(screen.getByTestId("where")).toHaveTextContent("/firmware?devices=d1");
    fireEvent.click(screen.getByRole("button", { name: "Update 1 device" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Update 1 device" }));
    await waitFor(() => expect(posts(calls, "/api/firmware/update")).toHaveLength(1));
    expect((posts(calls, "/api/firmware/update")[0]?.body as { deviceIds: string[] }).deviceIds).toEqual(["d1"]);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await screen.findByRole("region", { name: /Update 2 devices/ });
    // let anything that might re-run settle
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(posts(calls, "/api/firmware/update")).toHaveLength(1);
    for (const id of ["d2", "d3", "d4", "d5", "d6"]) expect(screen.getByRole("checkbox", { name: "Select Board " + id })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Choose devices to update" })).toBeDisabled();
    expect(screen.getByTestId("where")).toHaveTextContent(/^\/firmware$/);
  });

  it("applies the default selection once and takes the selection only from the query string", async () => {
    server({}, MANY);
    const first = renderWithProviders(<FirmwarePage />, "/firmware?devices=d2");
    expect(await screen.findByRole("button", { name: "Update 1 device" })).toBeEnabled();
    first.unmount();
    resetFirmware();
    renderWithProviders(<FirmwarePage />, "/firmware");
    // a direct visit gets the default (the devices that differ), once; unticking one stays unticked
    expect(await screen.findByRole("button", { name: "Update 6 devices" })).toBeEnabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Board d3" }));
    expect(screen.getByRole("button", { name: "Update 5 devices" })).toBeEnabled();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(screen.getByRole("button", { name: "Update 5 devices" })).toBeEnabled();
  });
});
