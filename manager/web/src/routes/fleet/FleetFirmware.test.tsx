import type { DeviceSummary } from "@shared/api";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetApiForTests } from "../../api/testing";
import { getBrowserWs } from "../../api/ws";
import { ConfirmProvider, ToastProvider, TooltipProvider } from "../../components/ui";
import { FakeWebSocket } from "../../test/fakes";
import { makeJob } from "../../test/jobs";
import { FleetPage } from "../FleetPage";
import { makeDevice } from "./fixtures";
import { filterCounts, summarize } from "./logic";

const GARAGE = makeDevice({ id: "3c71bf0a9e11", name: "Garage door", fwMatchesTarget: false, app_version: "0de951c" });
const WORKSHOP = makeDevice({ id: "a4cf12b3c4d5", name: "Workshop node", fwMatchesTarget: true });
const GREENHOUSE = makeDevice({ id: "a4cf12e81f20", name: "Greenhouse", fwMatchesTarget: false, health: "updating", app_version: "0de951c" });

function Probe() {
  const loc = useLocation();
  return <p>Firmware screen {loc.search}</p>;
}

function renderFleet() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <ToastProvider>
          <ConfirmProvider>
            <Routes>
              <Route path="/" element={<FleetPage />} />
              <Route path="/firmware" element={<Probe />} />
            </Routes>
          </ConfirmProvider>
        </ToastProvider>
      </TooltipProvider>
    </MemoryRouter>,
  );
}

function stubServer(devices: DeviceSummary[], jobs: unknown[] = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input).split("?")[0] ?? "";
      const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
      if (path === "/api/devices") return json(devices);
      if (path === "/api/jobs") return json(jobs);
      return json({ error: "Not found", code: "not_found" }, 404);
    }),
  );
}

beforeEach(() => {
  resetApiForTests();
  FakeWebSocket.reset();
  vi.stubGlobal("WebSocket", FakeWebSocket);
  localStorage.clear();
});
afterEach(() => {
  resetApiForTests();
  vi.unstubAllGlobals();
});

describe("Fleet and firmware", () => {
  it("counts the devices that differ from the target and filters on them", async () => {
    stubServer([GARAGE, WORKSHOP]);
    renderFleet();
    const strip = await screen.findByRole("region", { name: "Fleet summary" });
    const stat = within(strip).getByRole("button", { name: /Firmware differs/ });
    expect(stat).not.toHaveAttribute("aria-disabled");
    expect(stat).toHaveTextContent("1");
    expect(stat).toHaveTextContent("vs the target firmware");

    fireEvent.click(stat);
    await waitFor(() => expect(screen.queryByRole("heading", { level: 3, name: "Workshop node" })).not.toBeInTheDocument());
    expect(screen.getByRole("heading", { level: 3, name: "Garage door" })).toBeInTheDocument();
    expect(screen.getByText("0de951c · differs")).toBeInTheDocument();
  });

  it("tells the user where to choose a target while none exists", async () => {
    stubServer([makeDevice({ id: "a4cf12b3c4d5", name: "Workshop node" })]);
    renderFleet();
    const strip = await screen.findByRole("region", { name: "Fleet summary" });
    expect(within(strip).getByRole("button", { name: /Firmware differs/ })).toHaveAttribute("aria-disabled", "true");
    expect(within(strip).getByText("no target firmware chosen")).toBeInTheDocument();
  });

  it("opens the Firmware screen with the selected devices from the bulk bar", async () => {
    stubServer([GARAGE, WORKSHOP]);
    renderFleet();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select Garage door" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Workshop node" }));
    const bar = await screen.findByRole("region", { name: "Bulk actions" });
    fireEvent.click(within(bar).getByRole("button", { name: "Update firmware…" }));
    expect(await screen.findByText(`Firmware screen ?devices=${GARAGE.id},${WORKSHOP.id}`)).toBeInTheDocument();
  });

  it("shows a device that is being updated with its live progress", async () => {
    const job = (progress: number, updatedAt: string) =>
      makeJob({
        id: "job1",
        title: "Update Greenhouse",
        deviceIds: [GREENHOUSE.id],
        devices: [{ deviceId: GREENHOUSE.id, name: "Greenhouse", state: "running", step: "uploading", progress, message: "Sending the new firmware" }],
        updatedAt,
      });
    stubServer([GREENHOUSE, WORKSHOP], [job(0.64, "2026-11-10T09:00:01.000Z")]);
    renderFleet();
    getBrowserWs().connect();
    act(() => FakeWebSocket.last().open());

    const bar = await screen.findByRole("progressbar", { name: "Greenhouse firmware update" });
    expect(bar).toHaveAttribute("aria-valuenow", "64");
    expect(screen.getByText("Sending the new firmware")).toBeInTheDocument();
    expect(screen.getByText("Updating")).toBeInTheDocument();

    act(() => FakeWebSocket.last().emit({ t: "job", job: job(0.9, "2026-11-10T09:00:09.000Z") }));
    await waitFor(() => expect(screen.getByRole("progressbar", { name: "Greenhouse firmware update" })).toHaveAttribute("aria-valuenow", "90"));
    // the other device is untouched
    expect(screen.queryByRole("progressbar", { name: "Workshop node firmware update" })).not.toBeInTheDocument();
  });

  it("shows the percentage in the table view", async () => {
    localStorage.setItem("deesp32-fleet-prefs", JSON.stringify({ view: "table", sort: "name" }));
    stubServer(
      [GREENHOUSE],
      [
        makeJob({
          id: "job1",
          deviceIds: [GREENHOUSE.id],
          devices: [{ deviceId: GREENHOUSE.id, state: "running", progress: 0.5 }],
        }),
      ],
    );
    renderFleet();
    const table = await screen.findByRole("table");
    expect(await within(table).findByText("50%")).toBeInTheDocument();
  });

  it("summary logic: differs is null until a verdict exists", () => {
    const none = [makeDevice({ id: "a4cf12b3c4d5" })];
    expect(summarize(none).differs).toBeNull();
    expect(filterCounts(none).differs).toBeNull();
    expect(summarize([GARAGE, WORKSHOP]).differs).toBe(1);
  });
});
