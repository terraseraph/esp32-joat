import type { Job, JobAction } from "@shared/api";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetApiForTests } from "../../api/testing";
import { makeJob } from "../../test/jobs";
import { JobProgress } from "./JobProgress";

beforeEach(() => resetApiForTests());
afterEach(() => {
  resetApiForTests();
  vi.unstubAllGlobals();
});

const STEPS: Job["steps"] = [
  { id: "a", label: "Join the board's Wi-Fi", status: "done", startedAt: "2026-11-10T09:00:00.000Z", finishedAt: "2026-11-10T09:00:03.000Z" },
  { id: "b", label: "Send the settings", status: "running", detail: "Bench node", progress: 0.4 },
  { id: "c", label: "Wait for the board", status: "pending" },
  { id: "d", label: "Add it to the fleet", status: "skipped" },
];

describe("JobProgress", () => {
  it("running: state chip, overall bar, steps with their status and progress, message, Cancel", () => {
    render(<JobProgress job={makeJob({ id: "1", title: "Set up esp32-123456", steps: STEPS, progress: 0.4, message: "Sending the settings", actions: ["cancel", "pause"] })} onAction={() => {}} />);
    expect(screen.getByRole("heading", { name: "Set up esp32-123456" })).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
    const bar = screen.getByRole("progressbar", { name: "Set up esp32-123456: overall progress" });
    expect(bar).toHaveAttribute("aria-valuenow", "40");
    expect(screen.getByText("40%", { selector: ".job-pct" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Sending the settings");

    const steps = within(screen.getByRole("list", { name: "Steps" })).getAllByRole("listitem");
    expect(steps.map((s) => s.getAttribute("data-status"))).toEqual(["done", "running", "pending", "skipped"]);
    expect(steps[1]).toHaveAttribute("aria-current", "step");
    expect(steps[0]).not.toHaveAttribute("aria-current");
    expect(within(steps[1]!).getByText("Bench node")).toBeInTheDocument();
    expect(within(steps[1]!).getByRole("progressbar", { name: "Send the settings progress" })).toHaveAttribute("aria-valuenow", "40");
    expect(steps[0]).toHaveTextContent("Done");
    expect(steps[2]).toHaveTextContent("Not started");
    expect(steps[3]).toHaveTextContent("Skipped");

    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("a null progress is an indeterminate bar with no percentage; queued says it is waiting", () => {
    render(<JobProgress job={makeJob({ id: "1", state: "queued", progress: null, actions: ["cancel"] })} onAction={() => {}} />);
    const bar = screen.getByRole("progressbar");
    expect(bar).not.toHaveAttribute("aria-valuenow");
    expect(bar).toHaveClass("ind");
    expect(document.querySelector(".job-pct")).toBeNull();
    expect(screen.getByText("Waiting to start")).toBeInTheDocument();
  });

  it("paused: Resume is the primary action", () => {
    render(<JobProgress job={makeJob({ id: "1", state: "paused", actions: ["cancel", "resume"] })} onAction={() => {}} />);
    expect(screen.getByText("Paused")).toBeInTheDocument();
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Resume", "Cancel"]);
    expect(screen.getByRole("button", { name: "Resume" })).toHaveClass("primary");
  });

  it("interrupted (the Manager stopped mid-job): its own label and message, no actions", () => {
    render(
      <JobProgress
        job={makeJob({ id: "1", state: "interrupted", progress: 0.4, message: "The Manager stopped while this job was running", error: { code: "interrupted", message: "The Manager stopped while this job was running" }, actions: [], finishedAt: "2026-11-10T09:05:00.000Z" })}
        onAction={() => {}}
      />,
    );
    expect(screen.getByText("Interrupted")).toBeInTheDocument();
    expect(screen.getAllByText("The Manager stopped while this job was running").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("cancelling: no actions, state says so", () => {
    render(<JobProgress job={makeJob({ id: "1", state: "cancelling", actions: [] })} onAction={() => {}} />);
    expect(screen.getByText("Cancelling")).toBeInTheDocument();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("succeeded: Done chip, full green bar, nothing to press", () => {
    render(<JobProgress job={makeJob({ id: "1", state: "succeeded", progress: 1, actions: [], steps: STEPS.map((s) => ({ ...s, status: "done" as const })) })} onAction={() => {}} />);
    expect(screen.getByText("Done", { selector: ".chip" })).toBeInTheDocument();
    const bar = screen.getByRole("progressbar", { name: /overall progress/ });
    expect(bar).toHaveAttribute("aria-valuenow", "100");
    expect(bar).toHaveClass("ok");
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("failed: the error is a plain banner with the step it stopped at, Retry is offered", () => {
    const onAction = vi.fn();
    render(
      <JobProgress
        job={makeJob({
          id: "1",
          state: "failed",
          progress: 0.4,
          actions: ["retry"],
          steps: STEPS.map((s) => (s.id === "b" ? { ...s, status: "failed" as const } : s)),
          error: { code: "wifi_rejected", message: "The board could not join that Wi-Fi network. Check the password and try again.", step: "b" },
        })}
        onAction={onAction}
      />,
    );
    expect(screen.getByText("Failed", { selector: ".chip" })).toBeInTheDocument();
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("The board could not join that Wi-Fi network. Check the password and try again.");
    expect(alert).toHaveTextContent("It stopped at: Send the settings.");
    expect(alert).not.toHaveTextContent("wifi_rejected");
    expect(screen.getByRole("progressbar", { name: /overall progress/ })).toHaveClass("bad");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onAction).toHaveBeenCalledWith("retry", expect.objectContaining({ id: "1" }));
  });

  it("partial: per-device rows with state chips, messages and errors", () => {
    render(
      <JobProgress
        job={makeJob({
          id: "1",
          state: "partial",
          progress: 1,
          actions: ["retry"],
          devices: [
            { deviceId: "fe5e1fa50000", name: "Bench node", state: "done" },
            { deviceId: "fe5e1fa50001", name: "Garage", state: "failed", error: { code: "ota_failed", message: "The upload stopped halfway." } },
            { deviceId: "fe5e1fa50002", state: "rolled_back", message: "It went back to the old firmware." },
            { deviceId: "fe5e1fa50003", state: "running", progress: 0.5, message: "Sending" },
            { deviceId: "fe5e1fa50004", state: "queued" },
            { deviceId: "fe5e1fa50005", state: "skipped" },
            { deviceId: "fe5e1fa50006", state: "cancelled" },
            { deviceId: "fe5e1fa50007", state: "reverted" },
          ],
        })}
        onAction={() => {}}
      />,
    );
    expect(screen.getByText("Partly done")).toBeInTheDocument();
    const rows = within(screen.getByRole("list", { name: "Devices" })).getAllByRole("listitem");
    expect(rows).toHaveLength(8);
    expect(rows.map((r) => r.getAttribute("data-state"))).toEqual(["done", "failed", "rolled_back", "running", "queued", "skipped", "cancelled", "reverted"]);
    expect(within(rows[0]!).getByText("Bench node")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("Done")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("The upload stopped halfway.")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("Failed")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("Rolled back")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("It went back to the old firmware.")).toBeInTheDocument();
    expect(within(rows[3]!).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50");
    expect(within(rows[4]!).getByText("Waiting")).toBeInTheDocument();
    expect(within(rows[7]!).getByText("Reverted")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: /overall progress/ })).toHaveClass("warn");
  });

  it("cancelled: nothing running, steps cancelled, Retry when allowed", () => {
    render(<JobProgress job={makeJob({ id: "1", state: "cancelled", actions: ["retry"], steps: STEPS.map((s) => ({ ...s, status: "cancelled" as const })) })} onAction={() => {}} />);
    expect(screen.getByText("Cancelled", { selector: ".chip" })).toBeInTheDocument();
    for (const s of within(screen.getByRole("list", { name: "Steps" })).getAllByRole("listitem")) expect(s).toHaveAttribute("data-status", "cancelled");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("hideDevices leaves the device list to the parent", () => {
    render(<JobProgress hideDevices job={makeJob({ id: "1", devices: [{ deviceId: "x", state: "queued" }] })} onAction={() => {}} />);
    expect(screen.queryByRole("list", { name: "Devices" })).not.toBeInTheDocument();
  });

  it("without onAction the buttons call the generic endpoint and a failure is shown under them", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${String(input)}`);
        return new Response(JSON.stringify({ error: "This job cannot be cancelled right now (it is succeeded).", code: "job_action_unavailable" }), { status: 409 });
      }),
    );
    render(<JobProgress job={makeJob({ id: "j 1", actions: ["cancel"] })} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("This job cannot be cancelled right now"));
    expect(calls).toEqual(["POST /api/jobs/j%201/cancel"]);
  });

  it("disables the buttons while an action is in flight", async () => {
    let finish: () => void = () => {};
    const onAction = vi.fn((_a: JobAction) => new Promise<void>((r) => (finish = r)));
    render(<JobProgress job={makeJob({ id: "1", actions: ["cancel", "pause"] })} onAction={onAction} />);
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "Pause" })).toHaveAttribute("aria-busy", "true");
    finish();
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled());
  });
});
