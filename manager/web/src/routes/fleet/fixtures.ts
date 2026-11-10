import type { DeviceSummary } from "@shared/api";

/** A fully-populated healthy device; tests override what they care about. */
export function makeDevice(over: Partial<DeviceSummary> & { id: string }): DeviceSummary {
  return {
    name: "",
    label: "",
    notes: "",
    hostname: `esp32-${over.id.slice(-6)}`,
    host: "192.168.1.10",
    addedAt: "2026-11-01T10:00:00.000Z",
    addedVia: "mdns",
    health: "online",
    attention: [],
    lastSeen: "2026-11-10T09:59:58.000Z",
    fw: "0.1.0",
    app_version: "9dcba89",
    compile_date: null,
    fwMatchesTarget: null,
    uptime_s: 3600,
    boot_state: "healthy",
    safe_mode: false,
    safe_reason: null,
    rssi: -60,
    net_state: "sta_connected",
    mqtt: { configured: true, connected: true },
    memory: { pressure: "ok", free: 150_000, total: 320_000 },
    ota: { running_partition: "ota_0", image_state: "valid", rollback_possible: false, busy: false },
    io_count: 4,
    module_count: 0,
    link: "closed",
    queue: 0,
    ...over,
  };
}
