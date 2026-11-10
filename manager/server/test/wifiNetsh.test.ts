import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import {
  buildProfileXml,
  createNetshAdapter,
  createWifiAdapter,
  NO_ADAPTER_REASON,
  parseInterfaces,
  parseNetworks,
  WifiError,
  WINDOWS_ONLY_REASON,
  type ExecFn,
  type WifiAdapter,
} from "../src/wifi";
import { xmlEscape, type ExecResult } from "../src/wifi/netsh";
import { startTestServer, fetchJson, type TestServer } from "./helpers";

/** Nothing here runs netsh: `exec` is a recording fake that answers with captured (anonymised) output. */

const fixture = (name: string): string => readFileSync(path.join(import.meta.dirname, "fixtures", "netsh", name), "utf8");
const ok = (stdout: string): ExecResult => ({ stdout, stderr: "", code: 0 });

interface Call {
  file: string;
  args: string[];
}
type Reply = ExecResult | ((args: string[]) => ExecResult | Promise<ExecResult>);

function fakeExec(replies: Record<string, Reply>): { exec: ExecFn; calls: Call[] } {
  const calls: Call[] = [];
  const exec: ExecFn = async (file, args) => {
    calls.push({ file, args: [...args] });
    const r = replies[args.slice(0, 3).join(" ")] ?? replies[args.slice(0, 2).join(" ")];
    if (r === undefined) return { stdout: "", stderr: "unexpected command", code: 1 };
    return typeof r === "function" ? await r(args) : r;
  };
  return { exec, calls };
}

const tmpRoots: string[] = [];
const tmpRoot = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), "wifi-netsh-test-"));
  tmpRoots.push(d);
  return d;
};
after(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

const wifiIf = (name: string, address: string, extra: os.NetworkInterfaceInfo[] = []): (() => NodeJS.Dict<os.NetworkInterfaceInfo[]>) => () => ({
  [name]: [
    { address: "fe80::1", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", mac: "aa:bb:cc:00:11:22", internal: false, cidr: null, scopeid: 1 },
    { address, netmask: "255.255.255.0", family: "IPv4", mac: "aa:bb:cc:00:11:22", internal: false, cidr: `${address}/24` },
    ...extra,
  ],
  Ethernet: [{ address: "10.9.9.9", netmask: "255.0.0.0", family: "IPv4", mac: "aa:bb:cc:00:11:99", internal: false, cidr: "10.9.9.9/8" }],
});

describe("netsh parsing: show interfaces", () => {
  test("connected: ssid, profile, signal", () => {
    const [i, ...rest] = parseInterfaces(fixture("interfaces-connected.txt"));
    assert.equal(rest.length, 0);
    assert.deepEqual(i, { name: "Wi-Fi", state: "connected", ssid: "HomeNet", profile: "HomeNet", signal: 97, connected: true });
  });
  test("disconnected has no ssid and is not connected", () => {
    const list = parseInterfaces(fixture("interfaces-disconnected.txt"));
    assert.equal(list.length, 1);
    assert.equal(list[0]?.connected, false);
    assert.equal(list[0]?.ssid, null);
  });
  test("no wireless interface: empty list", () => {
    assert.deepEqual(parseInterfaces(fixture("interfaces-none.txt")), []);
    assert.deepEqual(parseInterfaces(""), []);
  });
  test("two interfaces: each block is its own, a profile name with spaces survives", () => {
    const list = parseInterfaces(fixture("interfaces-two.txt"));
    assert.deepEqual(
      list.map((i) => [i.name, i.connected, i.ssid, i.profile]),
      [
        ["Wi-Fi 2", false, null, null],
        ["Wi-Fi", true, "Work Net", "Work Net profile"],
      ],
    );
  });
  test("German output (other key names, other state word)", () => {
    const [i] = parseInterfaces(fixture("interfaces-german.txt"));
    assert.deepEqual(i, { name: "WLAN", state: "Verbunden", ssid: "Heimnetz", profile: "Heimnetz", signal: 88, connected: true });
  });
  test("CRLF line endings and trailing spaces (as printed by Windows) parse the same", () => {
    const real = fixture("interfaces-connected.txt").replace(/\n/g, " \r\n");
    assert.equal(parseInterfaces(real)[0]?.ssid, "HomeNet");
    assert.equal(parseInterfaces(real)[0]?.profile, "HomeNet");
  });
  test("an interface that is still associating is not connected yet", () => {
    const text = "    Name : Wi-Fi\n    State : associating\n    SSID : esp32-a1b2c3\n";
    assert.equal(parseInterfaces(text)[0]?.connected, false);
  });
  test("an SSID that contains a colon keeps it", () => {
    const text = "    Name : Wi-Fi\n    State : connected\n    SSID : Cafe: free\n    Profile : Cafe: free\n";
    assert.equal(parseInterfaces(text)[0]?.ssid, "Cafe: free");
  });
});

describe("netsh parsing: show networks mode=bssid", () => {
  test("English: secured vs open, strongest BSSID, hidden networks skipped", () => {
    const nets = parseNetworks(fixture("networks-bssid.txt"));
    assert.deepEqual(nets, [
      { ssid: "HomeNet", secured: true, signal: 97 },
      { ssid: "esp32-a1b2c3", secured: false, signal: 62 },
      { ssid: "esp32-d4e5f6", secured: true, signal: 80 },
      { ssid: "Neighbour 5G", secured: true, signal: 55 },
      { ssid: "Coffee Guest", secured: false, signal: 20 },
    ]);
  });
  test("German: Offen is open, Signalstärke is the signal", () => {
    const nets = parseNetworks(fixture("networks-german.txt"));
    assert.deepEqual(nets, [
      { ssid: "Heimnetz", secured: true, signal: 88 },
      { ssid: "esp32-0a0b0c", secured: false, signal: 45 },
      { ssid: "esp32-0d0e0f", secured: true, signal: 70 },
    ]);
  });
  test("nothing visible", () => {
    assert.deepEqual(parseNetworks("\nInterface name : Wi-Fi\nThere are 0 networks currently visible.\n"), []);
  });
  test("two adapters in one output: a network seen by both is listed once with the best signal", () => {
    const text = "Interface name : Wi-Fi\nSSID 1 : esp32-a1b2c3\n    Authentication : Open\n    BSSID 1 : 02:00:00:00:00:10\n         Signal : 30%\n\n" +
      "Interface name : Wi-Fi 2\nSSID 1 : esp32-a1b2c3\n    Authentication : Open\n    BSSID 1 : 02:00:00:00:00:10\n         Signal : 66%\n";
    assert.deepEqual(parseNetworks(text), [{ ssid: "esp32-a1b2c3", secured: false, signal: 66 }]);
  });
  test("the setup list only holds esp32-xxxxxx names (secured and open, with signal)", async () => {
    const { exec } = fakeExec({ "wlan show interfaces": ok(fixture("interfaces-connected.txt")), "wlan show networks": ok(fixture("networks-bssid.txt")) });
    const srv: TestServer = await startTestServer({
      discovery: { mdns: false, interfaces: () => [] },
      wifiAdapter: "system",
      setup: { adapter: createNetshAdapter({ exec }) },
    });
    try {
      const r = await fetchJson<{ supported: boolean; aps: { ssid: string; idSuffix: string; secured: boolean; signal: number | null; knownDeviceId: string | null }[] }>(
        `${srv.base}/api/setup/aps?refresh=true`,
      );
      assert.equal(r.status, 200);
      assert.equal(r.body.supported, true);
      assert.deepEqual(r.body.aps, [
        { ssid: "esp32-d4e5f6", idSuffix: "d4e5f6", secured: true, signal: 80, knownDeviceId: null },
        { ssid: "esp32-a1b2c3", idSuffix: "a1b2c3", secured: false, signal: 62, knownDeviceId: null },
      ]);
    } finally {
      await srv.close();
    }
  });
});

describe("netsh adapter: status, reasons, current connection", () => {
  test("info/current/scan on a connected PC; the scan names the interface", async () => {
    const { exec, calls } = fakeExec({ "wlan show interfaces": ok(fixture("interfaces-connected.txt")), "wlan show networks": ok(fixture("networks-bssid.txt")) });
    const a = createNetshAdapter({ exec });
    assert.equal(a.kind, "system");
    assert.deepEqual(await a.info(), { supported: true, reason: null, interfaceName: "Wi-Fi" });
    assert.deepEqual(await a.current(), { ssid: "HomeNet", profile: "HomeNet" });
    assert.equal((await a.scan()).length, 5);
    const scan = calls.find((c) => c.args[2] === "networks");
    assert.deepEqual(scan, { file: "netsh", args: ["wlan", "show", "networks", "mode=bssid", "interface=Wi-Fi"] });
  });
  test("disconnected: current is nothing, setup is still supported", async () => {
    const { exec } = fakeExec({ "wlan show interfaces": ok(fixture("interfaces-disconnected.txt")) });
    const a = createNetshAdapter({ exec });
    assert.equal((await a.info()).supported, true);
    assert.deepEqual(await a.current(), { ssid: null, profile: null });
  });
  test("two interfaces: the connected one is used", async () => {
    const { exec, calls } = fakeExec({ "wlan show interfaces": ok(fixture("interfaces-two.txt")), "wlan show networks": ok("") });
    const a = createNetshAdapter({ exec });
    assert.equal((await a.info()).interfaceName, "Wi-Fi");
    await a.scan();
    assert.ok(calls.some((c) => c.args.includes("interface=Wi-Fi")));
  });
  test("no wireless interface: unsupported, with a plain reason, and operations say so", async () => {
    const { exec } = fakeExec({ "wlan show interfaces": ok(fixture("interfaces-none.txt")) });
    const a = createNetshAdapter({ exec });
    assert.deepEqual(await a.info(), { supported: false, reason: NO_ADAPTER_REASON, interfaceName: null });
    await assert.rejects(a.scan(), (e: unknown) => e instanceof WifiError && e.kind === "unsupported");
    await assert.rejects(a.addTempProfile("esp32-a1b2c3", undefined, "de-esp32-setup-1"), (e: unknown) => e instanceof WifiError && e.kind === "unsupported");
    assert.equal(await a.localAddress(), null);
  });
  test("netsh missing (could not start) or failing: unsupported, nothing thrown by info()", async () => {
    for (const res of [{ stdout: "", stderr: "spawn netsh ENOENT", code: -1 }, { stdout: "The Wireless AutoConfig Service (wlansvc) is not running.", stderr: "", code: 1 }]) {
      const a = createNetshAdapter({ exec: () => Promise.resolve(res) });
      const info = await a.info();
      assert.equal(info.supported, false);
      assert.equal(info.reason, NO_ADAPTER_REASON);
    }
  });
  test("a failing scan reports what Windows said", async () => {
    const { exec } = fakeExec({ "wlan show interfaces": ok(fixture("interfaces-connected.txt")), "wlan show networks": { stdout: "The wireless local area network interface is powered down.", stderr: "", code: 1 } });
    await assert.rejects(createNetshAdapter({ exec }).scan(), /powered down/);
  });
});

describe("netsh adapter: commands (argv, no shell)", () => {
  const SSID = `Tom & "Jerry's" <5G> café – 家`;
  const PROFILE = "de-esp32-setup-0123abcd";

  function rig(over: Partial<Record<string, Reply>> = {}): { a: WifiAdapter; calls: Call[]; root: string; seen: { xml: string[]; filesAtCall: string[][] } } {
    const root = tmpRoot();
    const seen = { xml: [] as string[], filesAtCall: [] as string[][] };
    const { exec, calls } = fakeExec({
      "wlan show interfaces": ok(fixture("interfaces-connected.txt")),
      "wlan add profile": (args) => {
        const file = args.find((x) => x.startsWith("filename="))?.slice("filename=".length) ?? "";
        seen.xml.push(readFileSync(file, "utf8"));
        seen.filesAtCall.push(readdirSync(root));
        return ok("Profile de-esp32-setup-0123abcd is added on interface Wi-Fi.");
      },
      "wlan show networks": ok(fixture("networks-bssid.txt")),
      "wlan connect": ok("Connection request was completed successfully."),
      "wlan delete profile": ok('Profile "de-esp32-setup-0123abcd" is deleted from interface "Wi-Fi".'),
      ...over,
    });
    return { a: createNetshAdapter({ exec, tmpRoot: root, pollMs: 5 }), calls, root, seen };
  }

  test("add profile: exact argv, XML written for the command and gone right after", async () => {
    const { a, calls, root, seen } = rig();
    assert.equal(await a.addTempProfile(SSID, "pass&word<1>", PROFILE), PROFILE);
    const add = calls.find((c) => c.args[1] === "add");
    assert.ok(add);
    assert.equal(add.file, "netsh");
    assert.equal(add.args.length, 6);
    assert.deepEqual([add.args[0], add.args[1], add.args[2]], ["wlan", "add", "profile"]);
    assert.match(add.args[3] ?? "", /^filename=.*de-esp32-wifi-.*profile\.xml$/);
    assert.deepEqual(add.args.slice(4), ["interface=Wi-Fi", "user=current"]);
    assert.equal(seen.xml.length, 1);
    assert.equal(seen.filesAtCall[0]?.length, 1, "the private folder exists while netsh runs");
    assert.deepEqual(readdirSync(root), [], "and is removed right after");
    assert.ok(!existsSync((add.args[3] ?? "").slice("filename=".length)));
  });

  test("add profile failing still deletes the file, and the error does not echo the password", async () => {
    const { a, root } = rig({ "wlan add profile": { stdout: "The network profile is not valid.", stderr: "", code: 1 } });
    await assert.rejects(a.addTempProfile("esp32-a1b2c3", "hunter2-hunter2", PROFILE), (e: unknown) => {
      assert.ok(e instanceof WifiError);
      assert.equal(e.kind, "failed");
      assert.match(e.message, /not valid/);
      assert.ok(!e.message.includes("hunter2"));
      return true;
    });
    assert.deepEqual(readdirSync(root), []);
  });

  test("add profile throwing (exec rejects) also deletes the file", async () => {
    const root = tmpRoot();
    const a = createNetshAdapter({
      tmpRoot: root,
      exec: (_f, args) => (args[1] === "show" ? Promise.resolve(ok(fixture("interfaces-connected.txt"))) : Promise.reject(new Error("boom"))),
    });
    await assert.rejects(a.addTempProfile("esp32-a1b2c3", "hunter2-hunter2", PROFILE), /boom/);
    assert.deepEqual(readdirSync(root), []);
  });

  test("passwords never appear in any argv", async () => {
    const { a, calls } = rig();
    const pw = "S3cret-Pass!word";
    await a.addTempProfile("esp32-a1b2c3", pw, PROFILE);
    await a.connect(PROFILE, "esp32-a1b2c3", { timeoutMs: 20 }).catch(() => undefined);
    await a.deleteProfile(PROFILE);
    assert.ok(calls.length >= 4);
    assert.ok(!JSON.stringify(calls).includes(pw));
    assert.ok(!JSON.stringify(calls).includes("keyMaterial"));
  });

  test("temp profile names must carry the Manager prefix; other profiles are never added or deleted", async () => {
    const { a, calls } = rig();
    await assert.rejects(a.deleteProfile("HomeNet"), /left alone/);
    await assert.rejects(a.addTempProfile("esp32-a1b2c3", undefined, "HomeNet"), /left alone/);
    assert.equal(calls.filter((c) => c.args[1] === "delete" || c.args[1] === "add").length, 0);
  });

  test("connect: exact argv for ssids with spaces, quotes, ampersands and non-ASCII; waits until that ssid is current", async () => {
    let connected = false;
    const interfacesNow = (): ExecResult =>
      ok(connected ? `    Name : Wi-Fi\n    State : connected\n    SSID : ${SSID}\n    Profile : ${PROFILE}\n` : fixture("interfaces-connected.txt"));
    const { a, calls } = rig({
      "wlan show interfaces": () => interfacesNow(),
      "wlan connect": () => {
        setTimeout(() => (connected = true), 15);
        return ok("Connection request was completed successfully.");
      },
    });
    await a.connect(PROFILE, SSID, { timeoutMs: 2000 });
    const c = calls.find((x) => x.args[1] === "connect");
    assert.deepEqual(c, { file: "netsh", args: ["wlan", "connect", `name=${PROFILE}`, `ssid=${SSID}`, "interface=Wi-Fi"] });
    assert.equal(connected, true);
  });

  test("connect: times out when the PC never joins; the command failing is reported at once", async () => {
    const { a } = rig();
    await assert.rejects(a.connect(PROFILE, "esp32-a1b2c3", { timeoutMs: 40 }), (e: unknown) => e instanceof WifiError && e.kind === "timeout");
    const { a: b } = rig({ "wlan connect": { stdout: "There is no profile assigned to the specified interface.", stderr: "", code: 1 } });
    await assert.rejects(b.connect(PROFILE, "esp32-a1b2c3", { timeoutMs: 40 }), (e: unknown) => e instanceof WifiError && e.kind === "failed" && /no profile/.test(e.message));
  });

  test("connect honours the abort signal", async () => {
    const { a } = rig();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);
    await assert.rejects(a.connect(PROFILE, "esp32-a1b2c3", { timeoutMs: 5000, signal: ac.signal }), (e: unknown) => e instanceof WifiError && e.kind === "aborted");
  });

  test("delete profile: exact argv; a profile that is already gone is fine, other failures are not", async () => {
    const { a, calls } = rig();
    await a.deleteProfile(PROFILE);
    assert.deepEqual(calls.find((c) => c.args[1] === "delete"), { file: "netsh", args: ["wlan", "delete", "profile", `name=${PROFILE}`, "interface=Wi-Fi"] });
    const { a: gone } = rig({ "wlan delete profile": { stdout: `Profile "${PROFILE}" not found on any interface.`, stderr: "", code: 1 } });
    await gone.deleteProfile(PROFILE);
    const { a: bad } = rig({ "wlan delete profile": { stdout: "Access is denied.", stderr: "", code: 1 } });
    await assert.rejects(bad.deleteProfile(PROFILE), /Access is denied/);
  });

  test("never runs disconnect or anything else that is not on the list", async () => {
    const { a, calls } = rig();
    await a.info();
    await a.current();
    await a.scan();
    await a.addTempProfile("esp32-a1b2c3", undefined, PROFILE);
    await a.connect(PROFILE, "HomeNet", { timeoutMs: 500 });
    await a.deleteProfile(PROFILE);
    for (const c of calls) assert.ok(["show", "add", "connect", "delete"].includes(c.args[1] ?? ""), `unexpected netsh ${c.args.join(" ")}`);
    assert.ok(calls.every((c) => c.file === "netsh" && c.args[0] === "wlan"));
  });
});

describe("netsh adapter: local address of the Wi-Fi interface", () => {
  test("uses the interface netsh reported, IPv4 only, not link-local", async () => {
    const { exec } = fakeExec({ "wlan show interfaces": ok(fixture("interfaces-connected.txt")) });
    const link: os.NetworkInterfaceInfo = { address: "169.254.3.3", netmask: "255.255.0.0", family: "IPv4", mac: "aa:bb:cc:00:11:22", internal: false, cidr: "169.254.3.3/16" };
    const a = createNetshAdapter({ exec, networkInterfaces: wifiIf("Wi-Fi", "192.168.4.2", [link]) });
    assert.equal(await a.localAddress(), "192.168.4.2");
    assert.deepEqual(await a.endpoint("192.168.4.1"), { host: "192.168.4.1", localAddress: "192.168.4.2" });
  });
  test("another adapter's address is never used; no address means no binding", async () => {
    const { exec } = fakeExec({ "wlan show interfaces": ok(fixture("interfaces-two.txt")) });
    const a = createNetshAdapter({ exec, networkInterfaces: () => ({ Ethernet: [{ address: "10.9.9.9", netmask: "255.0.0.0", family: "IPv4", mac: "x", internal: false, cidr: null }] }) });
    assert.equal(await a.localAddress(), null);
    assert.deepEqual(await a.endpoint("192.168.4.1"), { host: "192.168.4.1" });
  });
});

describe("profile XML", () => {
  test("open network", () => {
    const xml = buildProfileXml("esp32-a1b2c3", undefined, "de-esp32-setup-aa");
    assert.match(xml, /<name>de-esp32-setup-aa<\/name>/);
    assert.match(xml, /<SSID><name>esp32-a1b2c3<\/name><\/SSID>/);
    assert.match(xml, /<authentication>open<\/authentication><encryption>none<\/encryption>/);
    assert.match(xml, /<connectionMode>manual<\/connectionMode>/);
    assert.ok(!xml.includes("sharedKey"));
    assert.deepEqual(buildProfileXml("x", "", "p"), buildProfileXml("x", undefined, "p"));
  });
  test("WPA2-Personal with the key as a plain pass phrase", () => {
    const xml = buildProfileXml("esp32-a1b2c3", "correct horse", "de-esp32-setup-aa");
    assert.match(xml, /<authentication>WPA2PSK<\/authentication><encryption>AES<\/encryption>/);
    assert.match(xml, /<keyType>passPhrase<\/keyType><protected>false<\/protected><keyMaterial>correct horse<\/keyMaterial>/);
  });
  test("XML special characters in the ssid, the profile name and the password are escaped", () => {
    assert.equal(xmlEscape(`a&b<c>d"e'f`), "a&amp;b&lt;c&gt;d&quot;e&apos;f");
    const xml = buildProfileXml(`A&B <"x"> 'y'`, `p&<>"'wd1234`, `n&<n>`);
    assert.ok(xml.includes("<name>A&amp;B &lt;&quot;x&quot;&gt; &apos;y&apos;</name>"));
    assert.ok(xml.includes("<keyMaterial>p&amp;&lt;&gt;&quot;&apos;wd1234</keyMaterial>"));
    assert.ok(xml.includes("<name>n&amp;&lt;n&gt;</name>"));
    assert.ok(!/&(?!amp;|lt;|gt;|quot;|apos;)/.test(xml.replace(/<\?xml[^>]*>/, "")), "no bare ampersand");
  });
  test("non-ASCII ssids are kept as they are", () => {
    assert.match(buildProfileXml("Café 家", undefined, "p"), /<name>Café 家<\/name>/);
  });
  test("passwords that Wi-Fi cannot use are refused before anything is written", () => {
    for (const bad of ["short", "x".repeat(64), "has\nnewline-1234"]) {
      assert.throws(() => buildProfileXml("esp32-a1b2c3", bad, "p"), (e: unknown) => e instanceof WifiError && e.kind === "auth");
    }
    assert.doesNotThrow(() => buildProfileXml("esp32-a1b2c3", "x".repeat(63), "p"));
    assert.doesNotThrow(() => buildProfileXml("esp32-a1b2c3", "x".repeat(8), "p"));
  });
});

describe("adapter selection (wifi/index.ts)", () => {
  test("system: netsh on win32, none elsewhere", () => {
    assert.equal(createWifiAdapter("system", { platform: "win32" }).kind, "system");
    for (const platform of ["linux", "darwin", "freebsd"] as const) assert.equal(createWifiAdapter("system", { platform }).kind, "none");
  });
  test("non-Windows reason is plain and operations fail with unsupported", async () => {
    const a = createWifiAdapter("system", { platform: "linux" });
    assert.deepEqual(await a.info(), { supported: false, reason: WINDOWS_ONLY_REASON, interfaceName: null });
    await assert.rejects(a.connect("p", "s"), (e: unknown) => e instanceof WifiError && e.kind === "unsupported");
  });
  test("fake and none are honoured on any platform", async () => {
    assert.equal(createWifiAdapter("fake", { platform: "win32" }).kind, "fake");
    const n = createWifiAdapter("none", { platform: "win32" });
    assert.equal(n.kind, "none");
    assert.match((await n.info()).reason ?? "", /--wifi-adapter none/);
  });
  test("the netsh options reach the adapter (injected exec is used on win32)", async () => {
    const { exec, calls } = fakeExec({ "wlan show interfaces": ok(fixture("interfaces-connected.txt")) });
    const a = createWifiAdapter("system", { platform: "win32", netsh: { exec } });
    assert.equal((await a.info()).interfaceName, "Wi-Fi");
    assert.equal(calls.length, 1);
  });
});
