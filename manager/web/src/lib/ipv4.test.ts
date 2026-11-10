import { describe, expect, it } from "vitest";
import { formatIpv4, isValidStatic, netmaskToPrefix, parseIpv4, prefixLabel, prefixMask, validateStatic, type StaticValues } from "./ipv4";

const GOOD: StaticValues = { ip: "192.168.1.50", netmask: "255.255.255.0", gateway: "192.168.1.1", dns: "" };

describe("parseIpv4", () => {
  it.each([
    ["0.0.0.0", 0],
    ["192.168.1.50", 3232235826],
    ["255.255.255.255", 4294967295],
  ])("accepts %s", (text, n) => expect(parseIpv4(text)).toBe(n));

  it.each(["", "1.2.3", "1.2.3.4.5", "256.1.1.1", "01.2.3.4", "1.2.3.04", "1.2.3.", " 1.2.3.4", "1.2.3.4 ", "a.b.c.d", "1.2.3.-4", "1..3.4", "1.2.3.1000"])(
    "rejects %j",
    (text) => expect(parseIpv4(text)).toBeNull(),
  );

  it("round-trips through formatIpv4", () => {
    expect(formatIpv4(parseIpv4("10.20.30.40") ?? 0)).toBe("10.20.30.40");
    expect(formatIpv4(0xffffff00)).toBe("255.255.255.0");
  });
});

describe("netmask", () => {
  it.each([
    ["128.0.0.0", 1],
    ["255.255.255.0", 24],
    ["255.255.255.252", 30],
    ["255.255.255.255", 32],
  ])("%s is /%i", (m, p) => expect(netmaskToPrefix(m)).toBe(p));

  it.each(["0.0.0.0", "255.0.255.0", "255.255.255.1", "255.255.0.255", "nope"])("%s is not a netmask", (m) => expect(netmaskToPrefix(m)).toBeNull());

  it("converts back and shows a prefix label", () => {
    expect(formatIpv4(prefixMask(24))).toBe("255.255.255.0");
    expect(formatIpv4(prefixMask(1))).toBe("128.0.0.0");
    expect(prefixLabel("255.255.0.0")).toBe("/16");
    expect(prefixLabel("junk")).toBeNull();
  });
});

describe("validateStatic", () => {
  it("accepts a normal config, with or without DNS", () => {
    expect(validateStatic(GOOD, { required: true })).toEqual({});
    expect(validateStatic({ ...GOOD, dns: "8.8.8.8" }, { required: true })).toEqual({});
    expect(isValidStatic(GOOD)).toBe(true);
  });

  it("accepts the extremes /1 and /30", () => {
    expect(validateStatic({ ip: "10.0.0.2", netmask: "255.255.255.252", gateway: "10.0.0.1", dns: "" }, { required: true })).toEqual({});
    expect(validateStatic({ ip: "10.0.0.2", netmask: "128.0.0.0", gateway: "10.0.0.1", dns: "" }, { required: true })).toEqual({});
  });

  it("asks for missing fields only when required", () => {
    const empty = { ip: "", netmask: "", gateway: "", dns: "" };
    expect(validateStatic(empty)).toEqual({});
    const e = validateStatic(empty, { required: true });
    expect(Object.keys(e).sort()).toEqual(["gateway", "ip", "netmask"]);
    expect(isValidStatic(empty)).toBe(false);
  });

  const cases: [string, Partial<StaticValues>, keyof StaticValues, RegExp][] = [
    ["ip with leading zero", { ip: "192.168.01.50" }, "ip", /four numbers/],
    ["ip out of range", { ip: "192.168.1.256" }, "ip", /four numbers/],
    ["ip is 0.0.0.0", { ip: "0.0.0.0" }, "ip", /not an address a device can use/],
    ["ip is loopback", { ip: "127.0.0.1" }, "ip", /not an address a device can use/],
    ["ip is multicast", { ip: "224.0.0.5" }, "ip", /not an address a device can use/],
    ["ip is broadcast", { ip: "255.255.255.255", netmask: "255.255.255.0", gateway: "192.168.1.1" }, "ip", /not an address a device can use/],
    ["ip is the network address", { ip: "192.168.1.0" }, "ip", /network address/],
    ["ip is the broadcast address", { ip: "192.168.1.255" }, "ip", /broadcast address/],
    ["netmask with gaps", { netmask: "255.0.255.0" }, "netmask", /Not a usable netmask/],
    ["netmask 0.0.0.0", { netmask: "0.0.0.0" }, "netmask", /Not a usable netmask/],
    ["netmask /31", { netmask: "255.255.255.254" }, "netmask", /Not a usable netmask/],
    ["netmask /32", { netmask: "255.255.255.255" }, "netmask", /Not a usable netmask/],
    ["netmask not a quad", { netmask: "24" }, "netmask", /four numbers/],
    ["gateway in another subnet", { gateway: "192.168.2.1" }, "gateway", /same subnet/],
    ["gateway equals ip", { gateway: "192.168.1.50" }, "gateway", /different address/],
    ["gateway is the network address", { gateway: "192.168.1.0" }, "gateway", /network address/],
    ["gateway is the broadcast address", { gateway: "192.168.1.255" }, "gateway", /broadcast address/],
    ["gateway is multicast", { gateway: "239.1.1.1" }, "gateway", /not an address a router can have/],
    ["dns not a quad", { dns: "dns.google" }, "dns", /four numbers/],
    ["dns multicast", { dns: "224.0.0.1" }, "dns", /DNS server/],
    ["dns 0.0.0.0", { dns: "0.0.0.0" }, "dns", /DNS server/],
    ["subnet overlaps the Setup AP", { ip: "192.168.4.50", gateway: "192.168.4.2" }, "ip", /Setup AP/],
    ["wide subnet covering the Setup AP", { ip: "192.168.1.50", netmask: "255.255.0.0", gateway: "192.168.1.1" }, "ip", /Setup AP/],
    ["a /2 that contains 192.168.4.0", { ip: "200.1.1.1", netmask: "192.0.0.0", gateway: "200.1.1.2" }, "ip", /Setup AP/],
  ];
  it.each(cases)("rejects: %s", (_name, over, field, message) => {
    const errors = validateStatic({ ...GOOD, ...over }, { required: true });
    expect(errors[field]).toMatch(message);
  });

  it("does not report the same problem on several fields", () => {
    const e = validateStatic({ ...GOOD, ip: "192.168.1.0" }, { required: true });
    expect(Object.keys(e)).toEqual(["ip"]);
  });

  it("trims spaces around values", () => {
    expect(validateStatic({ ip: " 192.168.1.50 ", netmask: "255.255.255.0 ", gateway: " 192.168.1.1", dns: " " }, { required: true })).toEqual({});
  });
});
