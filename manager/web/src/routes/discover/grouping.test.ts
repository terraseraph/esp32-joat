import type { DiscoveryResult } from "@shared/api";
import { describe, expect, it } from "vitest";
import { resultSub, resultTitle, viaLabels } from "./display";
import { groupResults } from "./grouping";

function res(over: Partial<DiscoveryResult> & { id: string }): DiscoveryResult {
  return {
    host: "192.168.1.10",
    name: "esp32-aaaaaa",
    hostname: "esp32-aaaaaa",
    fw: "0.1.0",
    via: "sweep",
    classification: "new",
    setup: false,
    netState: "sta_connected",
    lastSeen: "2026-11-10T09:00:00.000Z",
    ...over,
  };
}

describe("groupResults", () => {
  it("splits results into new, setup, known and ignored", () => {
    const g = groupResults({
      results: [
        res({ id: "a" }),
        res({ id: "b", setup: true, netState: "apsta_recovery" }),
        res({ id: "c", classification: "known" }),
        res({ id: "d", classification: "ignored" }),
      ],
      ignored: ["d", "e"],
    });
    expect(g.fresh.map((r) => r.id)).toEqual(["a"]);
    expect(g.setup.map((r) => r.id)).toEqual(["b"]);
    expect(g.known.map((r) => r.id)).toEqual(["c"]);
    expect(g.ignored.map((e) => e.id)).toEqual(["d", "e"]);
    expect(g.ignored[0]?.result?.id).toBe("d");
    expect(g.ignored[1]?.result).toBeUndefined();
  });

  it("keeps a known board in the fleet group even when it is in setup mode, and lists IP changes first", () => {
    const g = groupResults({
      results: [
        res({ id: "k1", classification: "known" }),
        res({ id: "k2", classification: "known", setup: true }),
        res({ id: "k3", classification: "known", ipChanged: { from: "192.168.1.8", to: "192.168.1.9" } }),
      ],
      ignored: [],
    });
    expect(g.setup).toEqual([]);
    expect(g.known.map((r) => r.id)).toEqual(["k3", "k1", "k2"]);
  });

  it("lists an id from the ignore list that was not seen, and does not duplicate one that was", () => {
    const g = groupResults({ results: [res({ id: "x", classification: "ignored" })], ignored: ["x"] });
    expect(g.ignored).toHaveLength(1);
    expect(groupResults({ results: [], ignored: [] })).toEqual({ fresh: [], setup: [], known: [], ignored: [] });
  });
});

describe("display helpers", () => {
  it("builds titles, secondary lines and via chips", () => {
    expect(resultTitle(res({ id: "a", name: "Bench test" }))).toBe("Bench test");
    expect(resultTitle(res({ id: "a", name: "", hostname: "" }))).toBe("a");
    expect(resultSub(res({ id: "a", name: "Bench test", hostname: "esp32-5a8821", host: "10.0.0.5" }))).toEqual(["esp32-5a8821", "10.0.0.5"]);
    expect(resultSub(res({ id: "a", host: "10.0.0.5" }))).toEqual(["10.0.0.5"]);
    expect(viaLabels("mdns+sweep+target+registry")).toEqual(["mDNS", "sweep", "address", "fleet"]);
  });
});
