import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  CommandResultMap,
  DeviceCommand,
  DeviceCommandName,
  DeviceStatus,
  DeviceWsEvent,
  Hardware,
  IoMap,
  ModuleInstance,
  NetworkStatus,
  OtaStatus,
  Rule,
  TelemetrySnapshot,
} from "../src/types/device-api";
import { COMMAND_NAMES, PENDING_COMMAND_NAMES } from "./fake/commands";
import { startFakeDevice } from "./fake/fakeDevice";
import { hardwarePayload, ioTopic, moduleInstances, otaStatus, statusPayload, telemetrySnapshot } from "./fake/state";
import { FAST, get } from "./fake/testkit";

// Compile-time exhaustiveness: adding a command to device-api.ts without handling it here fails typecheck.
const COMMANDS: Record<DeviceCommandName, true> = {
  "pin.configure": true, "pin.set": true, "io.hydrate": true, "module.catalog": true, "module.list": true,
  "module.add": true, "module.configure": true, "module.remove": true, "module.cmd": true, "rule.set": true,
  "rule.remove": true, "rule.list": true, "network.wifi.set": true, "network.wifi.scan": true, "network.wifi.clear": true,
  "network.recovery_ap": true, "network.ap.set_password": true, "mqtt.configure": true, "identity.set_name": true,
  "system.reboot": true, "system.factory_reset": true, "ota.apply": true, "ota.rollback": true, "serial.hello": true, "serial.bye": true,
  "network.ip.set": true, "network.ip.confirm": true, // PENDING firmware commands (fake: pendingFirmware option)
};
const RESULT_KEYS: Record<keyof CommandResultMap, true> = COMMANDS;
const STATUS_KEYS: Record<keyof DeviceStatus, true> = {
  v: true, id: true, fw: true, uptime_s: true, boot_count: true, reset_reason: true, heap_free: true, heap_min: true, memory: true,
  boot_state: true, safe_mode: true, network: true, mqtt: true, ota: true, io: true, name: true, topic_id: true, hostname: true,
  mac: true, chip: true, chip_info: true, ap_ssid: true, schema: true, generation: true, safe_reason: true, sinks: true,
};

describe("fake device is typed with device-api.ts", () => {
  it("the command catalog matches DeviceCommand and CommandResultMap", () => {
    assert.deepEqual([...COMMAND_NAMES, ...PENDING_COMMAND_NAMES].sort(), Object.keys(COMMANDS).sort());
    assert.deepEqual(Object.keys(RESULT_KEYS).sort(), Object.keys(COMMANDS).sort());
    const sample: DeviceCommand = { cmd: "pin.set", gpio: 2, value: 1 };
    assert.equal(sample.cmd, "pin.set");
  });

  it("fake state and serializers are assignable to the shared types", async () => {
    const dev = await startFakeDevice({ ...FAST, seed: "demo" });
    try {
      const s = dev.state;
      const io: IoMap = s.io;
      const net: NetworkStatus = s.network;
      const rules: Rule[] = s.rules;
      const status: DeviceStatus = statusPayload(s, 0);
      const telemetry: TelemetrySnapshot = telemetrySnapshot(s);
      const hw: Hardware = hardwarePayload(s);
      const ota: OtaStatus = otaStatus(s);
      const mods: ModuleInstance[] = moduleInstances(s);
      assert.ok(io && net && rules && ota && mods);
      assert.deepEqual(Object.keys(telemetry).sort(), Object.keys(status).filter((k) => !(["name", "topic_id", "hostname", "mac", "chip", "chip_info", "ap_ssid", "schema", "generation", "safe_reason", "sinks"] as string[]).includes(k)).sort());
      assert.equal(hw.pins.length, 34);
      // every key a real /status response has is a declared DeviceStatus key
      const wire = (await get<DeviceStatus>(dev, "/status")).body;
      for (const k of Object.keys(wire)) assert.ok(k in STATUS_KEYS, `undeclared status key ${k}`);
      // every io value maps to a WS topic
      for (const v of Object.values(io)) {
        const topic: DeviceWsEvent["topic"] = ioTopic(v);
        assert.match(topic, /^io\//);
      }
    } finally {
      await dev.close();
    }
  });
});
