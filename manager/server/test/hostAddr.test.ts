import assert from "node:assert/strict";
import { test } from "node:test";
import { HostAddrError, formatHostAddr, parseHostInput, resolveHostAddr, splitStoredHost } from "../src/device/hostAddr";

test("parseHostInput accepts the documented forms", () => {
  const cases: Array<[string, { host: string; port: number; isIp: boolean }]> = [
    ["192.168.1.42", { host: "192.168.1.42", port: 80, isIp: true }],
    ["  192.168.1.42  ", { host: "192.168.1.42", port: 80, isIp: true }],
    ["192.168.1.42:8080", { host: "192.168.1.42", port: 8080, isIp: true }],
    ["http://192.168.1.42", { host: "192.168.1.42", port: 80, isIp: true }],
    ["HTTP://192.168.1.42:81/", { host: "192.168.1.42", port: 81, isIp: true }],
    ["esp32-b3c4d5.local", { host: "esp32-b3c4d5.local", port: 80, isIp: false }],
    ["ESP32-B3C4D5.LOCAL:8101", { host: "esp32-b3c4d5.local", port: 8101, isIp: false }],
    ["mydevice", { host: "mydevice", port: 80, isIp: false }],
    ["[::1]:8101", { host: "::1", port: 8101, isIp: true }],
    ["[fe80::1]", { host: "fe80::1", port: 80, isIp: true }],
    ["::1", { host: "::1", port: 80, isIp: true }],
    ["host.example.", { host: "host.example", port: 80, isIp: false }],
  ];
  for (const [input, want] of cases) assert.deepEqual(parseHostInput(input), want, input);
});

test("parseHostInput rejects bad input with an invalid_host error", () => {
  const bad = [
    "",
    "   ",
    "http://",
    "https://192.168.1.42",
    "ftp://192.168.1.42",
    "ws://192.168.1.42",
    "192.168.1.42/api/v1/status",
    "http://192.168.1.42/index.html",
    "192.168.1.42?x=1",
    "192.168.1.42#a",
    "user:pw@192.168.1.42",
    "192.168.1.42:0",
    "192.168.1.42:65536",
    "192.168.1.42:abc",
    "192.168.1.42:",
    ":80",
    "999.1.1.1",
    "1.2.3",
    "bad host",
    "-bad.local",
    "a..b",
    "[::1",
    "[nope]:80",
    "1:2:3:4:5:6:7:8:9",
  ];
  for (const input of bad) {
    assert.throws(
      () => parseHostInput(input),
      (e) => e instanceof HostAddrError && e.code === "invalid_host" && e.message.length > 10,
      `should reject ${JSON.stringify(input)}`,
    );
  }
});

test("formatHostAddr stores ip or ip:port (port only when not 80) and round-trips", () => {
  assert.equal(formatHostAddr(parseHostInput("192.168.1.42")), "192.168.1.42");
  assert.equal(formatHostAddr(parseHostInput("192.168.1.42:80")), "192.168.1.42");
  assert.equal(formatHostAddr(parseHostInput("192.168.1.42:8101")), "192.168.1.42:8101");
  assert.equal(formatHostAddr(parseHostInput("[::1]:81")), "[::1]:81");
  assert.equal(formatHostAddr(parseHostInput("::1")), "::1");
  for (const stored of ["192.168.1.42", "192.168.1.42:8101", "[::1]:81", "::1"]) {
    const { hostname, port } = splitStoredHost(stored);
    assert.equal(formatHostAddr({ host: hostname, port, isIp: true }), stored);
  }
});

test("resolveHostAddr resolves names to an IPv4 and keeps IPs and ports", async () => {
  const lookup = async (h: string): Promise<string> => {
    if (h === "esp32-b3c4d5.local") return "192.168.1.42";
    throw new Error("ENOTFOUND");
  };
  assert.deepEqual(await resolveHostAddr(parseHostInput("esp32-b3c4d5.local:8101"), lookup), { host: "192.168.1.42", port: 8101, isIp: true });
  assert.deepEqual(await resolveHostAddr(parseHostInput("10.0.0.5"), lookup), { host: "10.0.0.5", port: 80, isIp: true });
  await assert.rejects(resolveHostAddr(parseHostInput("nope.local"), lookup), /ENOTFOUND/);
  // the real resolver: localhost -> IPv4 loopback
  assert.match((await resolveHostAddr(parseHostInput("localhost:81"))).host, /^127\./);
});
