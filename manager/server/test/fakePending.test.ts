import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NetworkStatus } from "../src/types/device-api";
import { startFakeDevice, type FakeDevice, type FakeDeviceOptions } from "./fake/fakeDevice";
import { FAST, ManualClock, cmd, failsWith, get, result, statusOf } from "./fake/testkit";

async function withDevice(opts: FakeDeviceOptions, fn: (dev: FakeDevice) => Promise<void>): Promise<void> {
  const dev = await startFakeDevice({ ...FAST, ...opts });
  try {
    await fn(dev);
  } finally {
    await dev.close();
  }
}

const net = async (dev: FakeDevice): Promise<NetworkStatus> => (await get<NetworkStatus>(dev, "/network")).body;
const STATIC = { cmd: "network.ip.set", mode: "static", ip: "192.168.1.50", netmask: "255.255.255.0", gateway: "192.168.1.1" };

describe("fake device: default (current firmware) shape", () => {
  it("has no wifi_change / ip_mode and refuses the pending commands", async () => {
    await withDevice({}, async (dev) => {
      const n = await net(dev);
      for (const k of ["wifi_change", "ip_mode", "netmask", "gateway", "dns", "ap_clients", "ip_change"]) assert.ok(!(k in n), `unexpected ${k}`);
      const status = await statusOf(dev);
      assert.ok(!("ip_mode" in status.network) && !("wifi_change" in status.network));
      failsWith(await cmd(dev, STATIC), "unknown cmd");
      failsWith(await cmd(dev, { cmd: "network.ip.confirm" }), "unknown cmd");
      const api = (await get<{ "x-commands": string[] }>(dev, "/openapi.json")).body;
      assert.ok(!api["x-commands"].includes("network.ip.set"));
    });
  });
});

describe("fake device: pendingFirmware", () => {
  it("reports the new fields, initially dhcp", async () => {
    await withDevice({ pendingFirmware: true }, async (dev) => {
      const n = await net(dev);
      assert.deepEqual(n.wifi_change, { result: "none" });
      assert.deepEqual(n.ip_change, { result: "none" });
      assert.equal(n.ip_mode, "dhcp");
      assert.equal(n.netmask, "255.255.255.0");
      assert.equal(n.gateway, "192.168.1.1");
      assert.equal(n.ap_clients, 0);
      assert.equal((await statusOf(dev)).network.ip_mode, "dhcp");
    });
  });

  it("static: pending, applied after the delay, confirm makes it ok", async () => {
    const clock = new ManualClock();
    await withDevice({ pendingFirmware: true, clock, ipApplyDelayMs: 1500, ipConfirmWindowMs: 90000 }, async (dev) => {
      const reply = result(await cmd<NetworkStatus>(dev, STATIC));
      assert.equal(reply.ip_change?.result, "pending");
      assert.equal(reply.ip_change?.applied, false);
      assert.equal(reply.ip_mode, "dhcp");
      failsWith(await cmd(dev, { cmd: "network.ip.confirm" }), /not applied/);
      clock.advance(1500);
      let n = await net(dev);
      assert.equal(n.ip_change?.applied, true);
      assert.equal(n.ip_change?.confirm_left_s, 90);
      assert.equal(n.ip_mode, "static");
      assert.equal(n.sta_ip, "192.168.1.50");
      assert.equal(n.dns, "192.168.1.1"); // defaults to the gateway
      clock.advance(30000);
      assert.equal((await net(dev)).ip_change?.confirm_left_s, 60);
      failsWith(await cmd(dev, { cmd: "network.ip.confirm", seq: 99 }), /seq/);
      const seq = n.ip_change?.seq;
      n = result(await cmd<NetworkStatus>(dev, { cmd: "network.ip.confirm", seq }));
      assert.equal(n.ip_change?.result, "ok");
      assert.equal(n.ip_change?.reason, "confirmed");
      assert.equal(n.ip_change?.applied, false);
      assert.ok(!("confirm_left_s" in (n.ip_change ?? {})));
      clock.advance(120000); // the revert timer is gone
      const after = await net(dev);
      assert.equal(after.ip_mode, "static");
      assert.equal(after.ip_change?.result, "ok");
      assert.equal(clock.pending, 0);
    });
  });

  it("static without a confirm reverts after the window (not_confirmed)", async () => {
    const clock = new ManualClock();
    await withDevice({ pendingFirmware: true, clock }, async (dev) => {
      result(await cmd(dev, { ...STATIC, dns: "1.1.1.1" }));
      clock.advance(1500);
      assert.equal((await net(dev)).dns, "1.1.1.1");
      clock.advance(89000);
      assert.equal((await net(dev)).ip_change?.result, "pending");
      clock.advance(1000);
      const n = await net(dev);
      assert.equal(n.ip_change?.result, "reverted");
      assert.equal(n.ip_change?.reason, "not_confirmed");
      assert.equal(n.ip_mode, "dhcp");
      assert.equal(n.sta_ip, "192.168.1.42");
      failsWith(await cmd(dev, { cmd: "network.ip.confirm" }), /no ip change/);
    });
  });

  it("dhcp after a confirmed static returns by itself (dhcp_lease)", async () => {
    const clock = new ManualClock();
    await withDevice({ pendingFirmware: true, clock }, async (dev) => {
      result(await cmd(dev, STATIC));
      clock.advance(1500);
      result(await cmd(dev, { cmd: "network.ip.confirm" }));
      result(await cmd(dev, { cmd: "network.ip.set", mode: "dhcp" }));
      clock.advance(1500);
      const n = await net(dev);
      assert.equal(n.ip_mode, "dhcp");
      assert.equal(n.ip_change?.result, "ok");
      assert.equal(n.ip_change?.reason, "dhcp_lease");
    });
  });

  it("refuses invalid static configs", async () => {
    await withDevice({ pendingFirmware: true, clock: new ManualClock() }, async (dev) => {
      const bad = async (patch: Record<string, unknown>, re: RegExp): Promise<void> => failsWith(await cmd(dev, { ...STATIC, ...patch }), re);
      await bad({ netmask: "255.0.255.0" }, /contiguous/);
      await bad({ netmask: "255.255.255.254" }, /contiguous/); // /31 is outside /1../30
      await bad({ netmask: "0.0.0.0" }, /contiguous/);
      await bad({ gateway: "192.168.2.1" }, /same subnet/);
      await bad({ ip: "192.168.1.01" }, /dotted-quad/); // leading zero
      await bad({ ip: "192.168.1" }, /dotted-quad/);
      await bad({ gateway: "192.168.1.50" }, /different/);
      await bad({ ip: "192.168.1.0" }, /network or broadcast/);
      await bad({ ip: "192.168.4.20", gateway: "192.168.4.1" }, /overlap/);
      await bad({ ip: "192.168.0.20", netmask: "255.255.0.0", gateway: "192.168.0.1" }, /overlap/); // a /16 that contains 192.168.4.0/24
      await bad({ dns: "224.0.0.1" }, /dns/);
      failsWith(await cmd(dev, { cmd: "network.ip.set", mode: "bogus" }), /static or dhcp/);
      assert.equal((await net(dev)).ip_change?.result, "none"); // nothing was started
    });
  });

  it("refuses while another change is pending, without saved Wi-Fi, or while offline", async () => {
    await withDevice({ pendingFirmware: true, clock: new ManualClock() }, async (dev) => {
      result(await cmd(dev, STATIC));
      failsWith(await cmd(dev, { ...STATIC, ip: "192.168.1.51" }), /already pending/);
    });
    await withDevice({ pendingFirmware: true, clock: new ManualClock() }, async (dev) => {
      dev.state.network.provisioned = false;
      failsWith(await cmd(dev, STATIC), /no saved wifi/);
    });
    await withDevice({ pendingFirmware: true, clock: new ManualClock() }, async (dev) => {
      dev.state.network.sta_connected = false;
      failsWith(await cmd(dev, STATIC), /not connected/);
      const n = result(await cmd<NetworkStatus>(dev, { cmd: "network.ip.set", mode: "dhcp" })); // saved at once while offline
      assert.equal(n.ip_change?.result, "ok");
      assert.equal(n.ip_change?.reason, "offline");
    });
  });

  it("a failed Wi-Fi change restores the old network and reports wifi_change", async () => {
    await withDevice({ pendingFirmware: true, clock: new ManualClock() }, async (dev) => {
      const before = await net(dev);
      assert.equal(before.wifi_change?.result, "none");
      failsWith(await cmd(dev, { cmd: "network.wifi.set", ssid: "fail", password: "wrongpass1" }), "wifi test failed; credentials not saved");
      const n = await net(dev);
      assert.equal(n.state, "sta_connected"); // not apsta_recovery
      assert.equal(n.sta_ip, "192.168.1.42");
      assert.equal(n.sta_connected, true);
      assert.equal(n.wifi_change?.result, "failed");
      assert.equal(n.wifi_change?.reason, "auth");
      assert.equal(n.wifi_change?.ssid, "fail");
      assert.equal(n.wifi_change?.restored_previous, true);
      assert.equal(n.wifi_change?.seq, 1);
      failsWith(await cmd(dev, { cmd: "network.wifi.set", ssid: "noap", password: "x" }), /wifi test failed/);
      const n2 = await net(dev);
      assert.equal(n2.wifi_change?.reason, "no_ap");
      assert.equal(n2.wifi_change?.seq, 2);
      // a success is recorded too
      result(await cmd(dev, { cmd: "network.wifi.set", ssid: "workshop-wifi", password: "goodpassword" }));
      const n3 = await net(dev);
      assert.equal(n3.wifi_change?.result, "ok");
      assert.equal(n3.wifi_change?.seq, 3);
      assert.ok(!("reason" in (n3.wifi_change ?? {})));
    });
  });

  it("a failed Wi-Fi change keeps the saved static config", async () => {
    const clock = new ManualClock();
    await withDevice({ pendingFirmware: true, clock }, async (dev) => {
      result(await cmd(dev, STATIC));
      clock.advance(1500);
      result(await cmd(dev, { cmd: "network.ip.confirm" }));
      failsWith(await cmd(dev, { cmd: "network.wifi.set", ssid: "fail", password: "wrongpass1" }), /wifi test failed/);
      const n = await net(dev);
      assert.equal(n.ip_mode, "static");
      assert.equal(n.sta_ip, "192.168.1.50");
      assert.equal(n.wifi_change?.restored_previous, true);
    });
  });

  it("a Wi-Fi credential change resets static to dhcp (ip_change reset)", async () => {
    const clock = new ManualClock();
    await withDevice({ pendingFirmware: true, clock }, async (dev) => {
      result(await cmd(dev, STATIC));
      clock.advance(1500);
      result(await cmd(dev, { cmd: "network.ip.confirm" }));
      assert.equal((await net(dev)).ip_mode, "static");
      result(await cmd(dev, { cmd: "network.wifi.set", ssid: "workshop-wifi", password: "goodpassword" }));
      const n = await net(dev);
      assert.equal(n.ip_mode, "dhcp");
      assert.equal(n.sta_ip, "192.168.1.42");
      assert.equal(n.ip_change?.result, "reset");
      assert.equal(n.ip_change?.reason, "wifi_change");
      assert.equal(n.wifi_change?.result, "ok");
    });
  });

  it("a Wi-Fi change cancels an unconfirmed IP change (reverted, wifi_change)", async () => {
    const clock = new ManualClock();
    await withDevice({ pendingFirmware: true, clock }, async (dev) => {
      result(await cmd(dev, STATIC));
      clock.advance(1500);
      failsWith(await cmd(dev, { cmd: "network.wifi.set", ssid: "fail", password: "wrongpass1" }), /wifi test failed/);
      const n = await net(dev);
      assert.equal(n.ip_change?.result, "reverted");
      assert.equal(n.ip_change?.reason, "wifi_change");
      assert.equal(n.ip_mode, "dhcp");
      assert.equal(clock.pending, 0);
    });
  });

  it("a reboot loses the RAM records and an unconfirmed static config", async () => {
    const clock = new ManualClock();
    await withDevice({ pendingFirmware: true, clock }, async (dev) => {
      result(await cmd(dev, STATIC));
      clock.advance(1500);
      await dev.reboot();
      const n = await net(dev);
      assert.equal(n.ip_mode, "dhcp");
      assert.deepEqual(n.ip_change, { result: "none" });
      assert.deepEqual(n.wifi_change, { result: "none" });
    });
  });
});
