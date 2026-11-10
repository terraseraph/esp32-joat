import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { createNetshAdapter, parseInterfaces, parseNetworks } from "../src/wifi";
import { decodeConsoleBytes, decodeWithCodePage, isSupportedCodePage, parseOemCodePage, tryDecodeUtf8 } from "../src/wifi/decode";
import { buildUtf8Command, createNetshExec, createOemCodePageLookup, type RawExecFn, type RawExecResult } from "../src/wifi/netshExec";

/**
 * Nothing here starts a process. The `.bin` fixtures are CRLF text encoded by the Windows code page tables (not by our own
 * decoder tables): `interfaces-cafe.txt` (UTF-8, cp850, cp437 and cp858 copies), `networks-german-umlauts.cp850.bin`,
 * `interfaces-polish.cp852.bin`, `networks-polish.cp852.bin`. cp437 and cp850 have no euro sign: Windows prints "?" there.
 */

const dir = path.join(import.meta.dirname, "fixtures", "netsh");
const bin = (name: string): Buffer => readFileSync(path.join(dir, name));
const text = (name: string): string => readFileSync(path.join(dir, name), "utf8").replace(/\r?\n/g, "\r\n");

const SSID = "Café-Wi-Fi ü€";
const SSID_NO_EURO = "Café-Wi-Fi ü?";

describe("decoding console bytes", () => {
  const cafe = text("interfaces-cafe.txt");

  test("UTF-8 output is decoded as UTF-8, whatever the code page says", () => {
    const bytes = bin("interfaces-cafe.utf8.bin");
    assert.equal(decodeConsoleBytes(bytes, 850), cafe);
    assert.equal(decodeConsoleBytes(bytes, null), cafe);
    assert.equal(decodeConsoleBytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]), 437), cafe, "a BOM is dropped");
  });

  test("cp850 and cp437 output (not valid UTF-8) is decoded with the OEM code page", () => {
    for (const [file, cp] of [["interfaces-cafe.cp850.bin", 850], ["interfaces-cafe.cp437.bin", 437]] as const) {
      const bytes = bin(file);
      assert.equal(tryDecodeUtf8(bytes), null, `${file} is not UTF-8`);
      assert.equal(decodeConsoleBytes(bytes, cp), cafe.replace("€", "?").replace("€", "?"), file);
    }
  });

  test("cp858 has the euro sign where cp850 has a dotless i", () => {
    assert.equal(decodeConsoleBytes(bin("interfaces-cafe.cp858.bin"), 858), cafe);
  });

  test("the same byte means different things in cp437 and cp850", () => {
    assert.equal(decodeWithCodePage(Buffer.from([0x9b]), 850), "ø");
    assert.equal(decodeWithCodePage(Buffer.from([0x9b]), 437), "¢");
    assert.equal(decodeWithCodePage(Buffer.from([0x82, 0x81]), 437), "éü");
  });

  test("code pages TextDecoder knows (866, 1251, 1252) and ones it does not (852, 437) both work", () => {
    assert.equal(decodeWithCodePage(Buffer.from([0x8f, 0xe0, 0xa8, 0xa2, 0xa5, 0xe2]), 866), "Привет");
    assert.equal(decodeWithCodePage(Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]), 1251), "Привет");
    assert.equal(decodeWithCodePage(Buffer.from([0x63, 0x61, 0x66, 0xe9]), 1252), "café");
    assert.equal(decodeWithCodePage(Buffer.from([0x9d, 0xa2, 0x64, 0xab]), 852), "Łódź");
    for (const cp of [437, 737, 775, 850, 852, 855, 857, 858, 860, 861, 862, 863, 865, 866, 869, 1250, 1251, 1252]) assert.ok(isSupportedCodePage(cp), String(cp));
  });

  test("an unknown or missing code page falls back to Latin-1 and never throws", () => {
    assert.equal(decodeWithCodePage(Buffer.from([0x63, 0x61, 0x66, 0x82]), null), "caf\u0082");
    assert.equal(decodeWithCodePage(Buffer.from([0x63, 0x61, 0x66, 0xe9]), 12345), "café");
    assert.equal(isSupportedCodePage(12345), false);
    assert.equal(decodeConsoleBytes(Buffer.from([0xe9, 0xff]), null), "éÿ");
  });

  test("plain ASCII is the same everywhere", () => {
    assert.equal(decodeConsoleBytes(Buffer.from("State : connected"), 850), "State : connected");
  });

  test("the OEM code page is read from reg query or chcp output", () => {
    assert.equal(parseOemCodePage("\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage\r\n    OEMCP    REG_SZ    850\r\n\r\n"), 850);
    assert.equal(parseOemCodePage("Active code page: 437\r\n"), 437);
    assert.equal(parseOemCodePage("Aktive Codepage: 850\r\n"), 850);
    assert.equal(parseOemCodePage("Aktuelle Codepage: 65001."), 65001);
    assert.equal(parseOemCodePage("nothing useful"), null);
    assert.equal(parseOemCodePage(""), null);
  });
});

const ok = (stdout: Buffer | string, stderr: Buffer | string = ""): RawExecResult => ({ stdout: Buffer.from(stdout), stderr: Buffer.from(stderr), code: 0 });

interface Call {
  file: string;
  args: string[];
  verbatim: boolean;
}
function fakeRaw(handler: (c: Call) => RawExecResult): { raw: RawExecFn; calls: Call[] } {
  const calls: Call[] = [];
  const raw: RawExecFn = async (file, args, opts) => {
    const c = { file, args: [...args], verbatim: opts?.verbatim === true };
    calls.push(c);
    return handler(c);
  };
  return { raw, calls };
}
const isReg = (c: Call): boolean => c.file === "reg";
const REG_850 = "\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage\r\n    OEMCP    REG_SZ    850\r\n";

describe("how netsh is started and read", () => {
  test("a safe read-only command goes through cmd.exe /c chcp 65001 (one verbatim command line)", () => {
    assert.deepEqual(buildUtf8Command("netsh", ["wlan", "show", "interfaces"]), { file: "cmd.exe", args: ["/d", "/s", "/c", '"chcp 65001>nul & netsh wlan show interfaces"'] });
    assert.deepEqual(buildUtf8Command("netsh", ["wlan", "show", "networks", "mode=bssid", "interface=Wi-Fi 2"]), {
      file: "cmd.exe",
      args: ["/d", "/s", "/c", '"chcp 65001>nul & netsh wlan show networks mode=bssid "interface=Wi-Fi 2""'],
    });
    assert.ok(buildUtf8Command("netsh", ["wlan", "connect", "name=de-esp32-setup-1", "ssid=Café ü", "interface=WLAN"]));
  });

  test("anything cmd.exe could read as syntax is never given to it", () => {
    for (const bad of ["ssid=a&calc", "ssid=a|b", "ssid=a>b", "ssid=%PATH%", "ssid=a^b", 'ssid="x"', "ssid=a!b", "filename=C:\\tmp\\p.xml", "ssid=a;b", "ssid=a(b)"]) {
      assert.equal(buildUtf8Command("netsh", ["wlan", "connect", bad]), null, bad);
    }
    assert.equal(buildUtf8Command("reg", ["query", "x"]), null);
    assert.equal(buildUtf8Command("netsh", []), null);
  });

  test("UTF-8 answer: decoded as is, the code page is never looked up", async () => {
    const { raw, calls } = fakeRaw(() => ok(bin("interfaces-cafe.utf8.bin")));
    const exec = createNetshExec(raw);
    const res = await exec("netsh", ["wlan", "show", "interfaces"]);
    assert.equal(res.stdout, text("interfaces-cafe.txt"));
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.file, "cmd.exe");
    assert.equal(calls[0]?.verbatim, true);
  });

  test("OEM answer: the code page comes from reg query (once, cached), not from netsh", async () => {
    const { raw, calls } = fakeRaw((c) => (isReg(c) ? ok(REG_850) : ok(bin("interfaces-cafe.cp850.bin"))));
    const exec = createNetshExec(raw);
    const a = await exec("netsh", ["wlan", "show", "interfaces"]);
    const b = await exec("netsh", ["wlan", "show", "interfaces"]);
    assert.equal(a.stdout, text("interfaces-cafe.txt").replace(/€/g, "?"));
    assert.equal(b.stdout, a.stdout);
    assert.equal(calls.filter(isReg).length, 1, "looked up once");
    assert.deepEqual(calls.find(isReg)?.args, ["query", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage", "/v", "OEMCP"]);
    assert.ok(calls.every((c) => c.args.every((x) => !/netsh/.test(x) || c.file === "cmd.exe")), "netsh only ever runs through the chcp wrapper");
  });

  test("when reg query fails chcp is asked; when both fail the text is read as Latin-1", async () => {
    const viaChcp = fakeRaw((c) => (isReg(c) ? { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 1 } : c.args.includes("chcp") ? ok("Aktive Codepage: 437.\r\n") : ok(bin("interfaces-cafe.cp437.bin"))));
    assert.equal((await createNetshExec(viaChcp.raw)("netsh", ["wlan", "show", "interfaces"])).stdout.includes(SSID_NO_EURO), true);

    const none = fakeRaw((c) => (c.file === "cmd.exe" && c.args.includes("chcp") ? { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 1 } : isReg(c) ? { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 1 } : ok(bin("interfaces-cafe.cp850.bin"))));
    const out = (await createNetshExec(none.raw)("netsh", ["wlan", "show", "interfaces"])).stdout;
    assert.ok(out.includes("Caf\u0082-Wi-Fi \u0081?"), "Latin-1 keeps the bytes, no crash");
  });

  test("an argument with shell syntax runs netsh directly (no cmd.exe), and its OEM output is still decoded", async () => {
    const { raw, calls } = fakeRaw((c) => (isReg(c) ? ok(REG_850) : ok(bin("interfaces-cafe.cp850.bin"))));
    const res = await createNetshExec(raw)("netsh", ["wlan", "connect", "name=de-esp32-setup-1", "ssid=a&b"]);
    assert.deepEqual(calls[0], { file: "netsh", args: ["wlan", "connect", "name=de-esp32-setup-1", "ssid=a&b"], verbatim: false });
    assert.ok(res.stdout.includes(SSID_NO_EURO));
  });

  test("if cmd.exe cannot be started netsh is run directly", async () => {
    const { raw, calls } = fakeRaw((c) => (c.file === "cmd.exe" ? { stdout: Buffer.alloc(0), stderr: Buffer.from("spawn cmd.exe ENOENT"), code: -1 } : ok("State : connected")));
    const res = await createNetshExec(raw)("netsh", ["wlan", "show", "interfaces"]);
    assert.equal(res.stdout, "State : connected");
    assert.deepEqual(calls.map((c) => c.file), ["cmd.exe", "netsh"]);
  });

  test("the code page lookup keeps a good answer and gives up after a few failures", async () => {
    let n = 0;
    const lookup = createOemCodePageLookup(async () => {
      n++;
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 1 };
    });
    for (let i = 0; i < 6; i++) assert.equal(await lookup(), null);
    assert.equal(n, 6, "three tries, each reg query + chcp");
  });
});

describe("the netsh adapter with non-ASCII output", () => {
  test("cp850 bytes: the connected SSID and the scan list carry the umlauts", async () => {
    const { raw } = fakeRaw((c) => {
      if (isReg(c)) return ok(REG_850);
      const line = c.args.join(" ");
      if (line.includes("show interfaces")) return ok(bin("interfaces-cafe.cp850.bin"));
      if (line.includes("show networks")) return ok(bin("networks-german-umlauts.cp850.bin"));
      return ok("");
    });
    const a = createNetshAdapter({ rawExec: raw });
    assert.deepEqual(await a.current(), { ssid: SSID_NO_EURO, profile: SSID_NO_EURO });
    const nets = await a.scan();
    assert.deepEqual(nets, [
      { ssid: SSID_NO_EURO, secured: true, signal: 74 },
      { ssid: "Gästenetz ohne Passwort", secured: false, signal: 41 },
      { ssid: "esp32-4d5e6f", secured: true, signal: 66 },
    ]);
  });

  test("UTF-8 bytes (the chcp path): the euro sign survives", async () => {
    const { raw } = fakeRaw(() => ok(bin("interfaces-cafe.utf8.bin")));
    const a = createNetshAdapter({ rawExec: raw });
    assert.deepEqual(await a.current(), { ssid: SSID, profile: SSID });
  });

  test("a connect to a non-ASCII SSID passes the right name to netsh and recognises the join", async () => {
    let connected = false;
    const { raw, calls } = fakeRaw((c) => {
      if (isReg(c)) return ok(REG_850);
      const line = c.args.join(" ");
      if (line.includes("show interfaces")) return ok(connected ? bin("interfaces-cafe.cp850.bin") : bin("interfaces-disconnected.txt"));
      if (line.includes("wlan connect")) {
        connected = true;
        return ok("Connection request was completed successfully.");
      }
      return ok("");
    });
    const a = createNetshAdapter({ rawExec: raw, pollMs: 5 });
    await a.connect("de-esp32-setup-1", SSID_NO_EURO, { timeoutMs: 500 });
    const connect = calls.find((c) => c.args.join(" ").includes("wlan connect"));
    assert.ok(connect?.args.join(" ").includes("ssid=Café-Wi-Fi ü?"));
  });
});

describe("label-independent parsing", () => {
  test("interfaces: the German labels with umlauts (cp850 decoded) still work on the primary path", () => {
    const [i] = parseInterfaces(text("interfaces-cafe.txt"));
    assert.deepEqual(i, { name: "Wi-Fi", state: "connected", ssid: SSID, profile: SSID, signal: 91, connected: true });
  });

  test("interfaces in Polish (labels the parser has never seen): state, signal and profile come from the structure", () => {
    const decoded = decodeConsoleBytes(bin("interfaces-polish.cp852.bin"), 852);
    assert.ok(decoded.includes("Łódź-Wi-Fi") && decoded.includes("połączono"));
    const [i] = parseInterfaces(decoded);
    assert.deepEqual(i, { name: "Wi-Fi", state: "połączono", ssid: "Łódź-Wi-Fi", profile: "Łódź-Wi-Fi", signal: 83, connected: true });
  });

  test("a Polish interface that is not connected has no SSID line", () => {
    const text = "    Nazwa : Wi-Fi\n    Opis : x\n    Stan : rozłączono\n";
    assert.deepEqual(parseInterfaces(text).map((i) => [i.connected, i.ssid]), [[false, null]]);
    const associating = "    Nazwa : Wi-Fi\n    Stan : rozłączono\n    SSID : esp32-aaaaaa\n";
    assert.equal(parseInterfaces(associating)[0]?.connected, false, "a known 'not connected' word wins over a leftover SSID");
  });

  test("networks in German cp850: umlaut labels, open vs secured, signal", () => {
    const nets = parseNetworks(decodeConsoleBytes(bin("networks-german-umlauts.cp850.bin"), 850));
    assert.deepEqual(nets.map((n) => [n.ssid, n.secured, n.signal]), [
      [SSID_NO_EURO, true, 74],
      ["Gästenetz ohne Passwort", false, 41],
      ["esp32-4d5e6f", true, 66],
    ]);
  });

  test("networks in Polish cp852: no label is known, the values (WPA2, CCMP, Brak) and the NN% lines decide", () => {
    const nets = parseNetworks(decodeConsoleBytes(bin("networks-polish.cp852.bin"), 852));
    assert.deepEqual(nets, [
      { ssid: "Łódź-Wi-Fi", secured: true, signal: 83 },
      { ssid: "Kawiarnia gość", secured: false, signal: 35 },
      { ssid: "Żółć 5G", secured: true, signal: 58 },
    ]);
  });

  test("an unrecognised block with too little to judge is treated as secured", () => {
    assert.deepEqual(parseNetworks("SSID 1 : mystery\n    Typ : x\n"), [{ ssid: "mystery", secured: true, signal: null }]);
  });
});
