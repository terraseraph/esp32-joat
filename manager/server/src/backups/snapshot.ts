import type { AppContext } from "../appContext";
import type { RegistryDevice } from "../store/registry";
import type { BackupFile, BackupModule, BackupPin, BackupRule } from "../types/api-backups";
import { readDeviceState, type DeviceConfigState } from "./deviceState";

/** Turn a device's configuration into a backup file (spec 3.8). Gaps list what the device would not tell us. */
export function backupFromState(state: DeviceConfigState, dev: RegistryDevice, managerVersion: string, now: Date = new Date()): BackupFile {
  const gaps: string[] = ["wifi", "ap_password"];
  if (state.mqtt) gaps.push("mqtt_credentials");

  const pins: BackupPin[] = state.pins.map((p) => {
    const { _from: _ignored, ...rest } = p.config as Record<string, unknown>;
    void _ignored;
    if (p.from === "live") {
      if (p.mode === "out") gaps.push(`pin:${p.gpio}:invert/pull/boot`);
      else if (p.mode === "in") gaps.push(`pin:${p.gpio}:invert/pull/irq`);
    }
    return { ...rest, gpio: p.gpio, mode: p.mode, _from: p.from } as BackupPin;
  });

  let modules: BackupModule[] = [];
  if (state.modules === null) gaps.push("modules_unavailable");
  else {
    modules = state.modules.map((m) => ({
      id: m.id,
      type: m.type,
      bus: m.bus,
      enabled: m.enabled,
      pins: { ...m.pins },
      ...(m.settings ? { settings: { ...m.settings } } : {}),
    }));
  }

  let rules: BackupRule[] = [];
  if (state.rules === null) gaps.push("rules_unavailable");
  else {
    rules = state.rules.map((r) => ({
      id: r.id,
      enabled: r.enabled,
      on: { gpio: r.on.gpio, op: r.on.op, value: r.on.value },
      then: { gpio: r.then.gpio, value: r.then.value },
      ...(r.else ? { else: { gpio: r.else.gpio, value: r.else.value } } : {}),
    }));
  }

  const name = state.name || dev.name || dev.hostname || dev.id;
  return {
    kind: "de-esp32-backup",
    v: 1,
    createdAt: now.toISOString(),
    manager: managerVersion,
    source: { id: dev.id, name, app_version: state.appVersion, ...(state.boardId ? { board_id: state.boardId } : {}) },
    name,
    pins,
    modules,
    rules,
    mqtt: state.mqtt ? { uri: state.mqtt.uri, root: state.mqtt.root } : null,
    gaps,
  };
}

/** Read a device and build its backup. Throws `DeviceError` when it cannot be reached. */
export async function snapshotDevice(app: AppContext, dev: RegistryDevice): Promise<BackupFile> {
  const state = await readDeviceState(app, dev, { board: true });
  return backupFromState(state, dev, app.version);
}
