import { describe, expect, it } from "vitest";
import { makeJob } from "../../../../test/jobs";
import { cannotChangeReason, ipChangeWords, ipJobOutcome, modeLabel, netmaskText } from "./logic";

describe("ip words", () => {
  it("names the modes", () => {
    expect(modeLabel("dhcp")).toBe("DHCP");
    expect(modeLabel("static")).toBe("Static");
    expect(modeLabel("unknown")).toBeNull();
    expect(modeLabel(null)).toBeNull();
    expect(netmaskText("255.255.0.0")).toBe("255.255.0.0 (/16)");
    expect(netmaskText("")).toBe("");
  });

  it("describes the device's ip_change", () => {
    expect(ipChangeWords(null)).toBeNull();
    expect(ipChangeWords({ result: "none" })).toBeNull();
    // an idle record with no detail is not "a change that worked"
    expect(ipChangeWords({ result: "ok" })).toBeNull();
    const pending = ipChangeWords({ result: "pending", mode: "static", ip: "10.0.0.5", applied: true, confirm_left_s: 12.4 });
    expect(pending).toMatchObject({ pending: true, tone: "acc" });
    expect(pending?.text).toContain("10.0.0.5");
    expect(pending?.text).toContain("12 s left");
    expect(ipChangeWords({ result: "ok", reason: "dhcp_lease", mode: "dhcp" })?.text).toMatch(/router/);
    expect(ipChangeWords({ result: "reverted", reason: "no_dhcp_lease" })?.text).toMatch(/gave the device no address/);
    expect(ipChangeWords({ result: "reverted", reason: "wifi_change" })?.text).toMatch(/Wi-Fi network was changed/);
    expect(ipChangeWords({ result: "failed", reason: "save_failed" })?.tone).toBe("bad");
    expect(ipChangeWords({ result: "mystery" as "none" })).toBeNull();
  });

  it("explains why Change is unavailable", () => {
    const s = { supported: true, reason: null, ipMode: "dhcp" as const, ip: "", netmask: "", gateway: "", dns: "", staConnected: true, ipChange: null, activeJobId: null };
    expect(cannotChangeReason(s, false)).toBeNull();
    expect(cannotChangeReason(s, true)).toMatch(/isn't answering/);
    expect(cannotChangeReason({ ...s, activeJobId: "j" }, false)).toMatch(/already running/);
    expect(cannotChangeReason({ ...s, supported: false }, false)).toBeNull();
  });

  it("turns finished jobs into plain outcomes", () => {
    const running = makeJob({ id: "a", kind: "ip-change", state: "running" });
    expect(ipJobOutcome(running, null)).toBeNull();
    const ok = makeJob({ id: "a", kind: "ip-change", state: "succeeded" });
    expect(ipJobOutcome(ok, { outcome: "ok", reason: null, host: "10.0.0.5", ipMode: "static" })?.title).toBe("The new address is in use.");
    expect(ipJobOutcome(ok, { outcome: "ok", reason: null, host: "10.0.0.9", ipMode: "dhcp" })?.title).toBe("The device is back on DHCP.");
    const failed = (code: string) => makeJob({ id: "a", kind: "ip-change", state: "failed", error: { code, message: "Nope" } });
    expect(ipJobOutcome(failed("not_reachable_new_address"), null)?.title).toBe("The device went back to its previous setting.");
    const rev = ipJobOutcome(failed("reverted"), null);
    expect(rev?.title).toBe("The device went back to its previous setting.");
    expect(rev?.body).toBe("Nope");
    const nr = ipJobOutcome(failed("not_reachable"), null);
    expect(nr?.title).toBe("The Manager could not find the device.");
    expect(nr?.tone).toBe("bad");
    expect(ipJobOutcome(failed("no_dhcp_lease"), null)?.title).toMatch(/did not give the device an address/);
    expect(ipJobOutcome(failed("lost_device"), null)?.title).toMatch(/lost track/);
    expect(ipJobOutcome(failed("confirm_refused"), null)?.title).toBe("Nope");
    expect(ipJobOutcome(makeJob({ id: "a", kind: "ip-change", state: "cancelled" }), null)?.body).toMatch(/90 seconds/);
  });
});
