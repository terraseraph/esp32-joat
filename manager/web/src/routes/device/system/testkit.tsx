import type { DeviceSummary } from "@shared/api";
import type { DeviceStatus } from "@shared/device-api";
import { render } from "@testing-library/react";
import { vi } from "vitest";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router";
import { ConfirmProvider } from "../../../components/ui/ConfirmDialog";
import { ToastProvider } from "../../../components/ui/Toast";
import { TooltipProvider } from "../../../components/ui/Tooltip";

export function makeSummary(over: Partial<DeviceSummary> = {}): DeviceSummary {
  return {
    id: "a4cf12b3c4d5", name: "Workshop node", label: "", notes: "", hostname: "esp32-b3c4d5", host: "192.168.1.42", addedAt: "2026-01-01T00:00:00Z",
    addedVia: "manual", health: "online", attention: [], lastSeen: new Date().toISOString(), fw: "0.1.0", app_version: "9dcba89", compile_date: "Nov 10 2026",
    fwMatchesTarget: null, uptime_s: 5220, boot_state: "healthy", safe_mode: false, safe_reason: null, rssi: -58, net_state: "sta_connected",
    mqtt: { configured: true, connected: true }, memory: { pressure: "ok", free: 151200, total: 327200 },
    ota: { running_partition: "ota_0", image_state: "valid", rollback_possible: true, busy: false },
    io_count: 2, module_count: 0, link: "closed", queue: 0, ...over,
  };
}

export function makeStatus(over: Partial<DeviceStatus> = {}): DeviceStatus {
  return {
    v: 1, id: "a4cf12b3c4d5", fw: "0.1.0", uptime_s: 5220, boot_count: 12, reset_reason: 1, heap_free: 151200, heap_min: 118400,
    memory: {
      pressure: "ok", alloc_failed: false, alloc_failed_size: 0, reserve: 24576,
      internal: { total: 327200, min: 118400, used: 176000, free: 151200, largest: 90112 },
      dma: { free: 140000, largest: 86016 }, psram: null,
      boot: [{ stage: "identity", free: 290000, largest: 110592 }],
      tasks: [{ name: "httpd", stack_min: 2412 }, { name: "io_rules", stack_min: 1204 }], tasks_truncated: false,
    },
    boot_state: "healthy", safe_mode: false,
    network: { state: "sta_connected", sta_ip: "192.168.1.42", ap_ip: "192.168.4.1", ap_ssid: "esp32-b3c4d5", ap_open: true, hostname: "esp32-b3c4d5", rssi: -58, provisioned: true, sta_connected: true },
    mqtt: { configured: true, connected: true } as unknown as DeviceStatus["mqtt"],
    ota: {
      fw: "0.1.0", idf: "v5.4.2", app_version: "9dcba89", project: "de_esp32_runtime", compile_date: "Nov 10 2026", compile_time: "09:12:44",
      running_partition: "ota_0", running_offset: 65536, running_size: 1048576, image_state: "valid", next_partition: "ota_1", next_size: 1048576,
      rollback_possible: true, busy: false, session: "idle", bytes: 0, total: 0, percent: 0,
    },
    io: {},
    name: "Workshop node", topic_id: "Workshop_node", hostname: "esp32-b3c4d5", mac: "a4:cf:12:b3:c4:d5", chip: "ESP32 rev3",
    chip_info: { model: "ESP32", revision: 3, cores: 2, features: ["wifi", "bt", "ble"] }, ap_ssid: "esp32-b3c4d5", schema: 4, generation: 37, safe_reason: "",
    ...over,
  };
}

export interface Call {
  method: string;
  path: string;
  body: unknown;
}

type Handler = { status?: number; body?: unknown } | ((call: Call) => { status?: number; body?: unknown });

/** fetch double routed by `"METHOD /path"`; records every call. Unknown routes answer 404. */
export function routeFetch(routes: Record<string, Handler>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).split("?")[0] ?? "";
      const method = (init?.method ?? "GET").toUpperCase();
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
      const call = { method, path, body };
      calls.push(call);
      const h = routes[`${method} ${path}`];
      if (!h) return new Response(JSON.stringify({ error: "Not found", code: "not_found" }), { status: 404 });
      const { status = 200, body: out } = typeof h === "function" ? h(call) : h;
      return new Response(out === undefined ? null : JSON.stringify(out), { status });
    }),
  );
  return calls;
}

export function renderWithProviders(ui: ReactElement, route = "/") {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <TooltipProvider>
        <ToastProvider>
          <ConfirmProvider>{ui}</ConfirmProvider>
        </ToastProvider>
      </TooltipProvider>
    </MemoryRouter>,
  );
}
