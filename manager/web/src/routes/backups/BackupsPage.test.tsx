import type { Job } from "@shared/api";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBackups, type BackupMeta, type BackupPlan } from "../../api/backups";
import { upsertJob } from "../../api/jobs";
import { resetApiForTests } from "../../api/testing";
import { ConfirmProvider, ToastProvider, TooltipProvider } from "../../components/ui";
import { FakeWebSocket } from "../../test/fakes";
import { makeJob } from "../../test/jobs";
import { makeSummary, routeFetch } from "../device/system/testkit";
import { BackupsPage } from "../BackupsPage";
import { BulkBackupButton } from "./BulkBackupButton";

const WORKSHOP = makeSummary({ id: "a4cf12b3c4d5", name: "Workshop node", host: "192.168.1.42" });
const GREENHOUSE = makeSummary({ id: "a4cf12e81f20", name: "Greenhouse", hostname: "esp32-e81f20", host: "192.168.1.57" });
const KITCHEN = makeSummary({ id: "246f28c0ffee", name: "Kitchen relay", hostname: "esp32-c0ffee", host: "192.168.1.88", health: "offline" });

const META: BackupMeta = {
  id: "bk1",
  createdAt: new Date(2026, 10, 10, 10, 0).toISOString(),
  source: { id: WORKSHOP.id, name: "Workshop node", app_version: "9dcba89" },
  name: "Workshop node",
  counts: { pins: 7, modules: 2, rules: 2 },
  gaps: ["wifi", "mqtt_credentials", "pin:13:invert/pull"],
  size: 2048,
  note: "",
};
const META_OLD: BackupMeta = {
  id: "bk2",
  createdAt: new Date(2026, 9, 28, 9, 0).toISOString(),
  source: { id: KITCHEN.id, name: "Kitchen relay", app_version: "5e3c76f" },
  name: "Kitchen relay",
  counts: { pins: 2, modules: 0, rules: 0 },
  gaps: ["wifi"],
  size: 900,
  note: "before rewiring",
};

function plan(over: Partial<BackupPlan> = {}): BackupPlan {
  return {
    targetId: GREENHOUSE.id,
    targetName: "Greenhouse",
    reachable: true,
    error: null,
    steps: [
      { id: "s1", op: "pin.disable", summary: "Turn off GPIO 16", cmd: { cmd: "pin.configure", gpio: 16, mode: "off" } },
      { id: "s2", op: "pin.configure", summary: "Set GPIO 4 to output (inverted)", cmd: {} },
      { id: "s3", op: "module.add", summary: "Add add-on rfid0 (RC522)", cmd: {} },
      { id: "s4", op: "rule.set", summary: "Add rule r32", cmd: {} },
    ],
    conflicts: [{ message: "GPIO 27 is used by add-on env1, which isn't being removed." }],
    warnings: [],
    unchanged: { pins: 3, modules: 0, rules: 0 },
    ...over,
  };
}

function renderPage(ui = <BackupsPage />) {
  return render(
    <MemoryRouter initialEntries={["/backups"]}>
      <TooltipProvider>
        <ToastProvider>
          <ConfirmProvider>{ui}</ConfirmProvider>
        </ToastProvider>
      </TooltipProvider>
    </MemoryRouter>,
  );
}

const DEVICES = { "GET /api/devices": { body: [WORKSHOP, GREENHOUSE, KITCHEN] } };

beforeEach(() => {
  resetApiForTests();
  resetBackups();
  FakeWebSocket.reset();
  vi.stubGlobal("WebSocket", FakeWebSocket);
});
afterEach(() => {
  resetApiForTests();
  resetBackups();
  vi.unstubAllGlobals();
});

describe("Backups list", () => {
  it("shows the empty state with both ways to get a first backup", async () => {
    routeFetch({ ...DEVICES, "GET /api/backups": { body: [] } });
    renderPage();
    expect(await screen.findByRole("heading", { name: "No backups yet" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Back up devices…" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Import file…" })).toHaveLength(2);
  });

  it("lists backups with counts, plain gap labels, notes and an offline hint", async () => {
    routeFetch({ ...DEVICES, "GET /api/backups": { body: [META, META_OLD] } });
    renderPage();
    const table = await screen.findByRole("table");
    const first = within(table).getByText("Workshop node").closest("tr")!;
    expect(within(first).getByText("7 pins · 2 add-ons · 2 rules")).toBeInTheDocument();
    expect(within(first).getByText("3 gaps")).toBeInTheDocument();
    expect(within(first).getByText("Wi-Fi network and password are not included")).toBeInTheDocument();
    expect(within(first).getByText("MQTT username and password are not included")).toBeInTheDocument();
    expect(within(first).getByText("GPIO 13: invert, pull-up and start level unknown")).toBeInTheDocument();
    expect(within(first).getByText("9dcba89")).toBeInTheDocument();
    expect(within(first).getByRole("link", { name: "Download backup of Workshop node" })).toHaveAttribute("href", "/api/backups/bk1?download=1");

    const second = within(table).getByText("Kitchen relay").closest("tr")!;
    expect(within(second).getByText(/offline now/)).toBeInTheDocument();
    expect(within(second).getByText("before rewiring")).toBeInTheDocument();
    expect(within(second).getByText("1 gap")).toBeInTheDocument();
    // more than one source device: a filter appears
    fireEvent.change(screen.getByLabelText("Show"), { target: { value: KITCHEN.id } });
    expect(within(table).queryByText("Workshop node")).toBeNull();
    expect(within(table).getByText("Kitchen relay")).toBeInTheDocument();
  });

  it("deletes a backup after confirming", async () => {
    const calls = routeFetch({ ...DEVICES, "GET /api/backups": { body: [META] }, "DELETE /api/backups/bk1": { status: 204 } });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Delete backup of Workshop node" }));
    expect(await screen.findByText("Delete this backup?")).toBeInTheDocument();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Delete backup" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.path === "/api/backups/bk1")).toBe(true));
    expect(await screen.findByRole("heading", { name: "No backups yet" })).toBeInTheDocument();
  });
});

describe("Back up now", () => {
  it("lets you pick only online devices and saves a backup for each", async () => {
    const calls = routeFetch({
      ...DEVICES,
      "GET /api/backups": { body: [] },
      [`POST /api/devices/${WORKSHOP.id}/backup`]: { status: 201, body: META },
    });
    renderPage();
    fireEvent.click((await screen.findAllByRole("button", { name: "Back up devices…" }))[0]!);
    const group = await screen.findByRole("group", { name: "Devices to back up" });
    expect(within(group).getByRole("checkbox", { name: "Kitchen relay" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Back up 0 devices" })).toBeDisabled();
    fireEvent.click(within(group).getByRole("checkbox", { name: "Workshop node" }));
    fireEvent.click(screen.getByRole("button", { name: "Back up 1 device" }));
    expect(await screen.findByText("7 pins · 2 add-ons · 2 rules")).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual([`/api/devices/${WORKSHOP.id}/backup`]);
    expect(within(screen.getByRole("list", { name: "Backup progress" })).getByText("Done")).toBeInTheDocument();
  });

  it("says why a backup failed in plain words", async () => {
    routeFetch({
      ...DEVICES,
      "GET /api/backups": { body: [] },
      [`POST /api/devices/${WORKSHOP.id}/backup`]: { status: 409, body: { error: "device offline", code: "device_offline" } },
    });
    renderPage();
    fireEvent.click((await screen.findAllByRole("button", { name: "Back up devices…" }))[0]!);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Workshop node" }));
    fireEvent.click(screen.getByRole("button", { name: "Back up 1 device" }));
    expect(await screen.findByText("Workshop node is offline. A backup reads the live device, so it has to be online.")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pick again" })).toBeInTheDocument();
  });

  it("the Fleet bulk button backs up the selection and toasts with a link", async () => {
    const calls = routeFetch({
      [`POST /api/devices/${WORKSHOP.id}/backup`]: { status: 201, body: META },
      [`POST /api/devices/${KITCHEN.id}/backup`]: { status: 409, body: { error: "offline", code: "device_offline" } },
    });
    renderPage(<BulkBackupButton devices={[WORKSHOP, KITCHEN]} />);
    fireEvent.click(screen.getByRole("button", { name: "Back up" }));
    expect(await screen.findByText("Backed up 1 of 2 devices")).toBeInTheDocument();
    expect(screen.getByText(/Kitchen relay: Kitchen relay is offline/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View backups" })).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(2);
  });
});

describe("Import", () => {
  const file = (text: string, name = "notes.json") => new File([text], name, { type: "application/json" });
  const open = async () => {
    fireEvent.click((await screen.findAllByRole("button", { name: "Import file…" }))[0]!);
    return (await screen.findByLabelText("Backup file")) as HTMLInputElement;
  };

  it("rejects a file that is not a backup without sending it", async () => {
    const calls = routeFetch({ ...DEVICES, "GET /api/backups": { body: [] } });
    renderPage();
    const input = await open();
    expect(screen.getByRole("button", { name: "Import" })).toBeDisabled();
    fireEvent.change(input, { target: { files: [file('{"hello":1}')] } });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This file isn't a de-esp32 backup (missing kind: de-esp32-backup)");
    fireEvent.change(input, { target: { files: [file("not json")] } });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("isn't valid JSON"));
    expect(calls.some((c) => c.path === "/api/backups/import")).toBe(false);
  });

  it("shows the server's plain reason when it refuses the file", async () => {
    routeFetch({
      ...DEVICES,
      "GET /api/backups": { body: [] },
      "POST /api/backups/import": { status: 422, body: { error: "The backup has no pins list.", code: "invalid_backup" } },
    });
    renderPage();
    const input = await open();
    fireEvent.change(input, { target: { files: [file('{"kind":"de-esp32-backup","v":1}')] } });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The backup has no pins list.");
    expect(screen.getByRole("dialog", { name: "Import a backup file" })).toBeInTheDocument();
  });

  it("imports a good file and closes", async () => {
    const calls = routeFetch({ ...DEVICES, "GET /api/backups": { body: [] }, "POST /api/backups/import": { status: 201, body: META } });
    renderPage();
    const input = await open();
    fireEvent.change(input, { target: { files: [file('{"kind":"de-esp32-backup","v":1,"pins":[]}')] } });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.find((c) => c.path === "/api/backups/import")?.body).toMatchObject({ kind: "de-esp32-backup" });
    expect(await screen.findByText("Imported the backup of Workshop node")).toBeInTheDocument();
  });
});

describe("Restore", () => {
  it("goes targets, what to copy, review plan, apply, and reports a partly applied target", async () => {
    const calls = routeFetch({
      ...DEVICES,
      "GET /api/backups": { body: [META] },
      "GET /api/jobs": { body: [] },
      "POST /api/backups/bk1/plan": { body: { plans: [plan()] } },
      "POST /api/backups/bk1/apply": { status: 201, body: makeJob({ id: "j1", kind: "backup-apply", title: "Restore Workshop node to Greenhouse", deviceIds: [GREENHOUSE.id], devices: [{ deviceId: GREENHOUSE.id, name: "Greenhouse", state: "running" }] }) },
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Restore backup of Workshop node to other devices" }));

    // targets
    expect(await screen.findByRole("heading", { name: "Restore Workshop node" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Kitchen relay" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Greenhouse" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    // what to copy: a restore copies everything except the name, which is opt-in
    for (const label of ["Pins", "Add-ons", "Rules", "MQTT broker"]) expect(screen.getByRole("checkbox", { name: new RegExp(`^${label}`) })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /^Also copy the device name/ })).not.toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: /^MQTT broker/ }));
    fireEvent.click(screen.getByRole("button", { name: "Review plan" }));

    // review: dry run, steps in order, conflict in amber
    expect(await screen.findByText("Set GPIO 4 to output (inverted)")).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/api/backups/bk1/plan")?.body).toEqual({ targetIds: [GREENHOUSE.id], include: { pins: true, modules: true, rules: true, mqtt: false, name: false } });
    expect(screen.getByText(/This is a dry run\. Nothing has been changed yet/)).toBeInTheDocument();
    expect(screen.getByText(/GPIO 27 is used by add-on env1/)).toBeInTheDocument();
    expect(screen.getByText("Already matching: 3 pins · 0 add-ons · 0 rules.")).toBeInTheDocument();
    expect(screen.getByText("Not changed: MQTT broker, device name.")).toBeInTheDocument();
    const order = screen.getAllByRole("heading", { level: 4 }).map((h) => h.textContent);
    expect(order).toEqual(["1Turn off pins", "2Set pins", "3Add or reconfigure add-ons", "4Add rules"]);
    expect(calls.some((c) => c.path.endsWith("/apply"))).toBe(false);

    // apply
    fireEvent.click(screen.getByRole("button", { name: "Apply to 1 device" }));
    expect(await screen.findByRole("region", { name: "Restore Workshop node to Greenhouse" })).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/api/backups/bk1/apply")?.body).toEqual({ targetIds: [GREENHOUSE.id], include: { pins: true, modules: true, rules: true, mqtt: false, name: false } });

    const finished: Job = makeJob({
      id: "j1",
      kind: "backup-apply",
      title: "Restore Workshop node to Greenhouse",
      state: "partial",
      progress: 1,
      actions: [],
      deviceIds: [GREENHOUSE.id],
      devices: [
        { deviceId: GREENHOUSE.id, name: "Greenhouse", state: "failed", error: { code: "device_error", message: "cs must be unique per reader", step: "s3" }, result: { applied: 2, total: 4, failedStep: "s3" } },
      ],
      updatedAt: "2026-11-10T09:00:09.000Z",
      finishedAt: "2026-11-10T09:00:09.000Z",
    });
    act(() => upsertJob(finished));
    expect(await screen.findByText("Greenhouse was only partly updated.")).toBeInTheDocument();
    expect(screen.getByText(/2 of 4 steps applied/)).toBeInTheDocument();
    expect(screen.getByText("Stopped at: Add add-on rfid0 (RC522)")).toBeInTheDocument();
    expect(screen.getByText("cs must be unique per reader")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run again for the device that failed" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
  });

  it("the device name is opt-in and the plan says whether it will change", async () => {
    const withRename = plan({ steps: [{ id: "n1", op: "identity.set_name", summary: "Rename the device to 'Workshop node'", cmd: { cmd: "identity.set_name", name: "Workshop node" } }], conflicts: [] });
    const calls = routeFetch({ ...DEVICES, "GET /api/backups": { body: [META] }, "GET /api/jobs": { body: [] }, "POST /api/backups/bk1/plan": { body: { plans: [plan({ conflicts: [] })] } } });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Restore backup of Workshop node to other devices" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Greenhouse" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Review plan" }));
    expect(await screen.findByTestId("plan-name")).toHaveTextContent("Name: kept as 'Greenhouse'");
    expect(calls.find((c) => c.path === "/api/backups/bk1/plan")?.body).toMatchObject({ include: { name: false } });
    // tick it: the request carries name: true and the plan shows old -> new
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /^Also copy the device name/ }));
    routeFetch({ ...DEVICES, "GET /api/backups": { body: [META] }, "GET /api/jobs": { body: [] }, "POST /api/backups/bk1/plan": { body: { plans: [withRename] } } });
    fireEvent.click(screen.getByRole("button", { name: "Review plan" }));
    await waitFor(() => expect(screen.getByTestId("plan-name")).toHaveTextContent("Name: 'Greenhouse' → 'Workshop node'"));
  });

  it("shows no changes, and an unreachable target, without offering Apply", async () => {
    routeFetch({
      ...DEVICES,
      "GET /api/backups": { body: [META] },
      "GET /api/jobs": { body: [] },
      "POST /api/backups/bk1/plan": {
        body: {
          plans: [
            plan({ steps: [], conflicts: [], unchanged: { pins: 7, modules: 2, rules: 2 } }),
            plan({ targetId: WORKSHOP.id, targetName: "Workshop node", reachable: false, error: "No answer from 192.168.1.42.", steps: [], conflicts: [] }),
          ],
        },
      },
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Restore backup of Workshop node to other devices" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Greenhouse" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Workshop node" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Review plan" }));

    expect(await screen.findByText("This device already matches. There is nothing to change.")).toBeInTheDocument();
    expect(screen.getByText("Already matching: 7 pins · 2 add-ons · 2 rules.")).toBeInTheDocument();
    expect(screen.getByText("Workshop node can't be reached")).toBeInTheDocument();
    expect(screen.getByText(/No answer from 192\.168\.1\.42\./)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Apply to/ })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Close" }).length).toBeGreaterThan(0);
  });
});

describe("Clone", () => {
  it("starts from a fresh backup of a device, leaves the name unticked and never targets the source", async () => {
    const calls = routeFetch({
      ...DEVICES,
      "GET /api/backups": { body: [META] },
      "GET /api/jobs": { body: [] },
      "POST /api/clone/plan": { body: { plans: [plan()] } },
      "POST /api/clone": { status: 201, body: makeJob({ id: "j2", kind: "backup-apply", title: "Clone Workshop node to Greenhouse" }) },
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Clone a device…" }));

    // source: a device (the first online one is preselected; pick another)
    expect(await screen.findByRole("heading", { name: "Clone a device" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /A device/ })).toBeChecked();
    expect(screen.getByLabelText("Device")).toHaveValue(GREENHOUSE.id);
    fireEvent.change(screen.getByLabelText("Device"), { target: { value: WORKSHOP.id } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    // targets: the source is not offered
    const group = await screen.findByRole("group", { name: "Devices to receive the setup" });
    expect(within(group).queryByRole("checkbox", { name: "Workshop node" })).toBeNull();
    fireEvent.click(within(group).getByRole("checkbox", { name: "Greenhouse" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    // what to copy: the name is off, everything else on
    expect(screen.getByRole("checkbox", { name: /^Also copy the device name/ })).not.toBeChecked();
    for (const label of ["Pins", "Add-ons", "Rules", "MQTT broker"]) expect(screen.getByRole("checkbox", { name: new RegExp(`^${label}`) })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Review plan" }));

    expect(await screen.findByText("Add add-on rfid0 (RC522)")).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/api/clone/plan")?.body).toEqual({ sourceId: WORKSHOP.id, targetIds: [GREENHOUSE.id], include: { pins: true, modules: true, rules: true, mqtt: true, name: false } });
    expect(screen.getByText("Not changed: Device name.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Apply to 1 device" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/clone")).toBe(true));
    expect(calls.find((c) => c.path === "/api/clone")?.body).toEqual({ sourceId: WORKSHOP.id, targetIds: [GREENHOUSE.id], include: { pins: true, modules: true, rules: true, mqtt: true, name: false } });
  });

  it("can clone from a saved backup through the backup routes", async () => {
    const calls = routeFetch({ ...DEVICES, "GET /api/backups": { body: [META] }, "GET /api/jobs": { body: [] }, "POST /api/backups/bk1/plan": { body: { plans: [plan()] } } });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Clone a device…" }));
    fireEvent.click(await screen.findByRole("radio", { name: /A saved backup/ }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Greenhouse" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("checkbox", { name: /^Also copy the device name/ })).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Review plan" }));
    await screen.findByText("Turn off GPIO 16");
    expect(calls.find((c) => c.path === "/api/backups/bk1/plan")?.body).toMatchObject({ targetIds: [GREENHOUSE.id], include: { name: false } });
  });
});
