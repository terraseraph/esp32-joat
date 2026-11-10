import { describe, expect, it } from "vitest";
import { ApiError } from "../../api/client";
import { addDeviceErrorMessage, scanIssues } from "./errors";
import { splitList, validateHost } from "./hostInput";

describe("validateHost", () => {
  it.each([
    "192.168.1.50",
    "192.168.1.50:8080",
    "127.0.0.1:8101",
    "http://192.168.1.50",
    "http://192.168.1.50/",
    "esp32-b3c4d5.local",
    "esp32-b3c4d5.local:8080",
    "my-board",
    "Kitchen.Example.com.",
    "[::1]",
    "[::1]:8080",
    "fe80::1",
    "  192.168.1.50  ",
  ])("accepts %s", (input) => {
    expect(validateHost(input).ok).toBe(true);
  });

  it.each([
    ["", /Enter the device/],
    ["   ", /Enter the device/],
    ["192.168.1.256", /not a valid IPv4/],
    ["192.168.1", /not a valid IPv4/],
    ["192.168.01.5", /not a valid IPv4/],
    ["192.168.1.50:0", /port/],
    ["192.168.1.50:99999", /port/],
    ["192.168.1.50:abc", /port/],
    ["https://192.168.1.50", /only plain http/],
    ["192.168.1.50/status", /without a path/],
    ["user@192.168.1.50", /without a path/],
    ["bad host", /without a path/],
    ["-bad.local", /not a valid host name/],
    ["a..b", /not a valid host name/],
    [":8080", /host part is empty/],
    ["[zz]", /not a valid IPv6/],
    ["1:2:3", /not a valid address/],
  ])("rejects %j", (input, message) => {
    const r = validateHost(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(message);
  });

  it("returns the trimmed input to send", () => {
    expect(validateHost("  http://192.168.1.50:8080 ")).toEqual({ ok: true, host: "http://192.168.1.50:8080" });
  });
});

describe("splitList", () => {
  it("splits on commas, spaces and newlines", () => {
    expect(splitList("10.0.0.0/24, 10.0.1.0/24  10.0.2.0/24\n")).toEqual(["10.0.0.0/24", "10.0.1.0/24", "10.0.2.0/24"]);
    expect(splitList("")).toEqual([]);
  });
});

describe("error messages", () => {
  const err = (code: string, message = "server says no", details?: unknown) => new ApiError(422, code, message, details);

  it("maps the add-device codes to plain messages and keeps unknown ones verbatim", () => {
    expect(addDeviceErrorMessage(err("probe_timeout"), "192.168.1.50")).toMatch(/No answer from 192\.168\.1\.50/);
    expect(addDeviceErrorMessage(err("device_unreachable"), "10.0.0.1:9")).toMatch(/10\.0\.0\.1:9 could not be reached/);
    expect(addDeviceErrorMessage(err("captive_redirect"), "x")).toBe("That address redirects to 192.168.4.1: a device in setup mode or another captive portal.");
    expect(addDeviceErrorMessage(err("not_de_esp32"), "192.168.1.1")).toBe("192.168.1.1 answered, but it isn't a de-esp32 device.");
    expect(addDeviceErrorMessage(err("invalid_host", "port must be 1-65535"), "x")).toBe("port must be 1-65535");
    expect(addDeviceErrorMessage(err("something_else", "Verbatim text"), "x")).toBe("Verbatim text");
  });

  it("sorts invalid_body details by field", () => {
    const issues = scanIssues(
      err("invalid_body", "Invalid scan request", [
        { path: "/subnets/0", message: "bad cidr" },
        { path: "/targets/1", message: "bad target" },
        { path: "/mdns", message: "must be boolean" },
      ]),
    );
    expect(issues).toEqual({ subnets: ["bad cidr"], targets: ["bad target"], other: ["must be boolean"] });
    expect(scanIssues(err("invalid_body", "Plain message")).other).toEqual(["Plain message"]);
  });
});
