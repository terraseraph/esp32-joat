import { describe, expect, it } from "vitest";
import { activeUpdateIds, sameBuild } from "../../api/firmware";
import { makeJob } from "../../test/jobs";
import { makeDevice } from "../fleet/fixtures";
import { buildRows, countRows, defaultSelection, eligibility, jobTally, rowVersions } from "./logic";

const none = new Set<string>();

describe("eligibility", () => {
  it("explains every reason a device cannot be updated", () => {
    const why = (over: Parameters<typeof makeDevice>[0]) => eligibility(makeDevice(over), none);
    expect(why({ id: "a", health: "offline" })).toMatchObject({ ok: false, note: "Offline, can't update" });
    expect(why({ id: "a", health: "unreachable" })).toMatchObject({ ok: false, note: "Unreachable, can't update" });
    expect(why({ id: "a", health: "rebooting" }).ok).toBe(false);
    expect(why({ id: "a", health: "updating" }).note).toBe("Already being updated");
    expect(why({ id: "a", ota: { running_partition: "ota_1", image_state: "pending_verify", rollback_possible: true, busy: false } }).note).toBe("Still verifying its last update");
    expect(why({ id: "a", ota: { running_partition: "ota_0", image_state: "valid", rollback_possible: false, busy: true } }).note).toBe("Busy with another update");
    expect(eligibility(makeDevice({ id: "a" }), new Set(["a"])).note).toBe("Already being updated");
  });

  it("allows devices that differ, are up to date (reinstall) or have no verdict", () => {
    expect(eligibility(makeDevice({ id: "a", fwMatchesTarget: false }), none)).toMatchObject({ ok: true, tone: "ok" });
    expect(eligibility(makeDevice({ id: "a", fwMatchesTarget: true }), none)).toMatchObject({ ok: true, note: "Up to date · select to reinstall" });
    expect(eligibility(makeDevice({ id: "a", fwMatchesTarget: null }), none).ok).toBe(true);
  });
});

describe("rows", () => {
  const devices = [
    makeDevice({ id: "a", fwMatchesTarget: false }),
    makeDevice({ id: "b", fwMatchesTarget: false, health: "offline" }),
    makeDevice({ id: "c", fwMatchesTarget: true }),
  ];
  it("counts and preselects the updatable devices that differ", () => {
    const rows = buildRows(devices, none);
    expect(countRows(rows)).toEqual({ all: 3, differs: 2, same: 1, cant: 1, ready: 2, readyDiffer: 1 });
    expect([...defaultSelection(rows)]).toEqual(["a"]);
  });
});

describe("jobs", () => {
  it("tallies device outcomes in plain words", () => {
    const job = makeJob({
      id: "j",
      devices: [
        { deviceId: "a", state: "done" },
        { deviceId: "b", state: "failed" },
        { deviceId: "c", state: "rolled_back" },
        { deviceId: "d", state: "queued" },
        { deviceId: "e", state: "cancelled" },
      ],
    });
    expect(jobTally(job)).toBe("1 updated · 1 failed · 1 rolled back · 1 not started · 1 waiting");
  });

  it("reads versions from a device result and ignores anything else", () => {
    expect(rowVersions({ fromVersion: "a", toVersion: "b", partition: "ota_1" })).toEqual({ from: "a", to: "b" });
    expect(rowVersions(undefined)).toEqual({ from: null, to: null });
    expect(rowVersions({ fromVersion: 3 })).toEqual({ from: null, to: null });
  });

  it("lists only devices that are still waiting or running in unfinished firmware jobs", () => {
    const jobs = [
      makeJob({ id: "1", deviceIds: ["a", "b"], devices: [{ deviceId: "a", state: "done" }, { deviceId: "b", state: "running" }] }),
      makeJob({ id: "2", deviceIds: ["c"], devices: [] }),
      makeJob({ id: "3", deviceIds: ["d"], state: "succeeded", devices: [{ deviceId: "d", state: "queued" }] }),
      makeJob({ id: "4", kind: "backup-apply", deviceIds: ["e"] }),
    ];
    expect([...activeUpdateIds(jobs)].sort()).toEqual(["b", "c"]);
  });
});

describe("sameBuild", () => {
  it("needs the same version and, when both are known, the same build date", () => {
    expect(sameBuild({ app_version: "9dcba89", compile_date: "Nov 10 2026" }, { version: "9dcba89", date: "Nov 10 2026" })).toBe(true);
    expect(sameBuild({ app_version: "9dcba89", compile_date: "Nov 8 2026" }, { version: "9dcba89", date: "Nov 10 2026" })).toBe(false);
    expect(sameBuild({ app_version: "9dcba89", compile_date: null }, { version: "9dcba89", date: "Nov 10 2026" })).toBe(true);
    expect(sameBuild({ app_version: null, compile_date: null }, { version: "9dcba89", date: "" })).toBe(false);
  });
});
