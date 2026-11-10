import { describe, expect, it } from "vitest";
import {
  attentionLabel, deviceSubtitle, deviceTitle, formatAgo, formatBytes, formatRssi, formatUptime,
  healthLabel, healthTone, linkLabel,
} from "./format";

describe("format", () => {
  it("titles", () => {
    const d = { id: "a1", label: "", name: "", hostname: "", host: "1.2.3.4" };
    expect(deviceTitle(d)).toBe("a1");
    expect(deviceTitle({ ...d, hostname: "esp" })).toBe("esp");
    expect(deviceTitle({ ...d, hostname: "esp", name: "Bench" })).toBe("Bench");
    expect(deviceTitle({ ...d, hostname: "esp", name: "Bench", label: "Door" })).toBe("Door");
    expect(deviceSubtitle({ hostname: "esp", host: "1.2.3.4" })).toBe("esp · 1.2.3.4");
    expect(deviceSubtitle({ hostname: "", host: "1.2.3.4" })).toBe("1.2.3.4");
  });
  it("formatAgo", () => {
    const now = Date.parse("2026-01-10T12:00:00Z");
    const ago = (s: number) => formatAgo(new Date(now - s * 1000).toISOString(), now);
    expect(ago(2)).toBe("just now");
    expect(ago(5)).toBe("5 s ago");
    expect(ago(180)).toBe("3 min ago");
    expect(ago(7200)).toBe("2 h ago");
    expect(ago(86400)).toBe("1 day ago");
    expect(ago(4 * 86400)).toBe("4 days ago");
    expect(formatAgo(null)).toBe("never");
  });
  it("formatUptime", () => {
    expect(formatUptime(45)).toBe("45 s");
    expect(formatUptime(720)).toBe("12 min");
    expect(formatUptime(2 * 3600 + 5 * 60)).toBe("2 h 5 min");
    expect(formatUptime(3 * 86400 + 4 * 3600)).toBe("3 d 4 h");
    expect(formatUptime(null)).toBe("-");
  });
  it("formatBytes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(148 * 1024)).toBe("148 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3 MB");
    expect(formatBytes(null)).toBe("-");
  });
  it("formatRssi", () => {
    expect(formatRssi(-50)).toEqual({ label: "-50 dBm · Excellent", bars: 4 });
    expect(formatRssi(-60).bars).toBe(3);
    expect(formatRssi(-70).bars).toBe(2);
    expect(formatRssi(-80).bars).toBe(1);
    expect(formatRssi(-95).bars).toBe(0);
    expect(formatRssi(null)).toEqual({ label: "No signal", bars: 0 });
  });
  it("labels and tones", () => {
    expect(healthLabel("rebooting")).toBe("Restarting");
    expect(healthTone("online")).toBe("ok");
    expect(healthTone("offline")).toBe("bad");
    expect(healthTone("unreachable")).toBe("warn");
    expect(attentionLabel("mqtt_disconnected")).toBe("MQTT disconnected");
    expect(attentionLabel("host_mismatch")).toBe("Another device answers at this address");
    expect(linkLabel("open")).toBe("Live");
    expect(linkLabel("full")).toBe("WS full · polling");
    expect(linkLabel("closed")).toBe("Not live");
    expect(linkLabel("connecting")).toBe("Connecting");
  });
});
