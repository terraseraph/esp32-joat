import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { atomicWrite } from "./atomicWrite";

/**
 * The device registry (`<dataDir>/registry.json`, spec 3.2). Loaded once at start, kept in memory, saved
 * debounced (at most once per window) through `atomicWrite`, flushed on close. A file that cannot be read is
 * never overwritten silently: it is renamed to `registry.json.corrupt-<timestamp>` and the registry starts empty.
 */

const Opt = Type.Optional;

/** Cached last status summary so the fleet renders instantly when a device is offline. Unknown keys are kept. */
export const LastSummarySchema = Type.Object(
  {
    fw: Opt(Type.String()),
    app_version: Opt(Type.String()),
    compile_date: Opt(Type.String()),
    boot_state: Opt(Type.String()),
    safe_mode: Opt(Type.Boolean()),
    uptime_s: Opt(Type.Number()),
    rssi: Opt(Type.Number()),
    pressure: Opt(Type.String()),
    mqtt_connected: Opt(Type.Boolean()),
    running_partition: Opt(Type.String()),
    image_state: Opt(Type.String()),
    // Additions (beyond spec 3.2) so the whole summary can be rebuilt from the cache:
    safe_reason: Opt(Type.String()),
    net_state: Opt(Type.String()),
    mqtt_configured: Opt(Type.Boolean()),
    mem_free: Opt(Type.Number()),
    mem_total: Opt(Type.Number()),
    rollback_possible: Opt(Type.Boolean()),
    ota_busy: Opt(Type.Boolean()),
    io_count: Opt(Type.Integer()),
    module_count: Opt(Type.Integer()),
    attention: Opt(Type.Array(Type.String())),
    ip_mode: Opt(Type.Union([Type.Literal("dhcp"), Type.Literal("static")])),
  },
  { additionalProperties: true },
);
export type LastSummary = Static<typeof LastSummarySchema>;

export const AddedViaSchema = Type.Union([Type.Literal("mdns"), Type.Literal("sweep"), Type.Literal("manual")]);
export type AddedVia = Static<typeof AddedViaSchema>;

/** A pin object as sent to `pin.configure` (minimal; the device persists it verbatim). */
export type PinShadowEntry = Record<string, unknown>;

export const RegistryDeviceSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    host: Type.String({ minLength: 1 }),
    hostname: Type.String(),
    name: Type.String(),
    label: Type.String(),
    notes: Type.String(),
    addedAt: Type.String(),
    addedVia: AddedViaSchema,
    lastSeen: Opt(Type.String()),
    last: Opt(LastSummarySchema),
    pinShadow: Type.Record(Type.String(), Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: true },
);
export type RegistryDevice = Static<typeof RegistryDeviceSchema>;

export const RegistryFileSchema = Type.Object(
  { v: Type.Literal(1), devices: Type.Array(RegistryDeviceSchema), ignored: Type.Array(Type.String()) },
  { additionalProperties: true },
);
export type RegistryFile = Static<typeof RegistryFileSchema>;

export type RegistryChange =
  | { kind: "added"; id: string; device: RegistryDevice }
  | { kind: "updated"; id: string; device: RegistryDevice }
  | { kind: "removed"; id: string }
  | { kind: "ignored"; id: string };

export interface UpsertInput {
  id: string;
  host: string;
  hostname?: string;
  name?: string;
  addedVia: AddedVia;
}

/** Fields `update()` may change. `lastSeen`/`last` are written by the health poller. */
export type RegistryPatch = Partial<Pick<RegistryDevice, "host" | "hostname" | "name" | "label" | "notes" | "lastSeen" | "last">>;

export interface RegistryStore {
  list(): RegistryDevice[];
  get(id: string): RegistryDevice | undefined;
  /** Create the device, or (when the id exists) update its host/hostname/name only. Reports whether it was created. */
  upsert(input: UpsertInput): { device: RegistryDevice; created: boolean };
  /** Patch an existing device; undefined when the id is unknown. No-op patches do not emit or save. */
  update(id: string, patch: RegistryPatch): RegistryDevice | undefined;
  remove(id: string): boolean;
  ignore(id: string): void;
  unignore(id: string): boolean;
  isIgnored(id: string): boolean;
  ignoredIds(): string[];
  /** Remember the pin object last sent with `pin.configure` for a GPIO; `null` (or mode disabled) removes it. */
  setPinShadow(id: string, gpio: number | string, pin: PinShadowEntry | null): void;
  /** Subscribe to changes; returns an unsubscribe function. */
  onChange(fn: (c: RegistryChange) => void): () => void;
  /** Write pending changes now. Never rejects (failures are logged). */
  flush(): Promise<void>;
  /** Path of the renamed corrupt file when the load had to set one aside. */
  readonly recoveredFrom: string | null;
}

export function registryPath(dataDir: string): string {
  return path.join(dataDir, "registry.json");
}

export interface RegistryOptions {
  dataDir: string;
  /** Save debounce window in ms (default 1000). */
  debounceMs?: number;
  log?: (msg: string) => void;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export async function createRegistry(opts: RegistryOptions): Promise<RegistryStore> {
  const log = opts.log ?? (() => {});
  const debounceMs = opts.debounceMs ?? 1000;
  const file = registryPath(opts.dataDir);
  const devices = new Map<string, RegistryDevice>();
  const ignored = new Set<string>();
  const events = new EventEmitter();
  let recoveredFrom: string | null = null;

  // ---- load ----
  let text: string | null = null;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (text !== null) {
    let problem: string | null = null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      problem = `not valid JSON (${(err as Error).message})`;
    }
    if (problem === null && !Value.Check(RegistryFileSchema, parsed)) {
      const first = [...Value.Errors(RegistryFileSchema, parsed)][0];
      problem = `unexpected content at ${first?.path || "/"}: ${first?.message ?? "invalid"}`;
    }
    if (problem !== null) {
      recoveredFrom = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      await fs.rename(file, recoveredFrom);
      log(`registry.json ${problem}; moved it to ${recoveredFrom} and starting with an empty registry`);
    } else {
      const data = parsed as RegistryFile;
      for (const d of data.devices) devices.set(d.id, d);
      for (const id of data.ignored) ignored.add(id);
    }
  }

  // ---- saving (debounced: the first change of a window schedules the write; later changes ride along) ----
  let dirty = false;
  let timer: NodeJS.Timeout | null = null;
  let writing: Promise<void> = Promise.resolve();

  const snapshot = (): string => {
    const data: RegistryFile = { v: 1, devices: [...devices.values()], ignored: [...ignored] };
    return JSON.stringify(data, null, 2) + "\n";
  };

  const write = (): Promise<void> => {
    writing = writing.then(async () => {
      if (!dirty) return;
      dirty = false;
      try {
        await fs.mkdir(opts.dataDir, { recursive: true });
        await atomicWrite(file, snapshot());
      } catch (err) {
        dirty = true;
        log(`could not save registry.json: ${(err as Error).message}`);
      }
    });
    return writing;
  };

  const markDirty = (): void => {
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void write();
    }, debounceMs);
    timer.unref();
  };

  const emit = (c: RegistryChange): void => {
    markDirty();
    events.emit("change", c);
  };

  const emitUpdated = (d: RegistryDevice): RegistryDevice => {
    emit({ kind: "updated", id: d.id, device: d });
    return d;
  };

  return {
    recoveredFrom,
    list: () => [...devices.values()],
    get: (id) => devices.get(id),

    upsert(input) {
      const existing = devices.get(input.id);
      if (!existing) {
        const device: RegistryDevice = {
          id: input.id,
          host: input.host,
          hostname: input.hostname ?? "",
          name: input.name ?? input.hostname ?? "",
          label: "",
          notes: "",
          addedAt: new Date().toISOString(),
          addedVia: input.addedVia,
          pinShadow: {},
        };
        devices.set(device.id, device);
        emit({ kind: "added", id: device.id, device });
        return { device, created: true };
      }
      const next: RegistryDevice = { ...existing, host: input.host };
      if (input.hostname !== undefined) next.hostname = input.hostname;
      if (input.name !== undefined) next.name = input.name;
      if (sameJson(next, existing)) return { device: existing, created: false };
      devices.set(next.id, next);
      return { device: emitUpdated(next), created: false };
    },

    update(id, patch) {
      const existing = devices.get(id);
      if (!existing) return undefined;
      const next: RegistryDevice = { ...existing };
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) (next as Record<string, unknown>)[k] = v;
      if (sameJson(next, existing)) return existing;
      devices.set(id, next);
      return emitUpdated(next);
    },

    remove(id) {
      if (!devices.delete(id)) return false;
      emit({ kind: "removed", id });
      return true;
    },

    ignore(id) {
      if (ignored.has(id)) return;
      ignored.add(id);
      emit({ kind: "ignored", id });
    },
    unignore(id) {
      if (!ignored.delete(id)) return false;
      emit({ kind: "ignored", id });
      return true;
    },
    isIgnored: (id) => ignored.has(id),
    ignoredIds: () => [...ignored],

    setPinShadow(id, gpio, pin) {
      const existing = devices.get(id);
      if (!existing) return;
      const key = String(gpio);
      const shadow = { ...existing.pinShadow };
      if (pin === null || pin.mode === "disabled") {
        if (!(key in shadow)) return;
        delete shadow[key];
      } else {
        if (sameJson(shadow[key], pin)) return;
        shadow[key] = pin;
      }
      const next = { ...existing, pinShadow: shadow };
      devices.set(id, next);
      emitUpdated(next);
    },

    onChange(fn) {
      events.on("change", fn);
      return () => events.off("change", fn);
    },

    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await write();
    },
  };
}
