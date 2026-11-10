import { describe, expect, it } from "vitest";
import { buildMqttConfigure, mqttPrefixPreview, netStateWords, validateApPassword, validateMqttRoot, validateMqttUri, wifiChangeSentence, type MqttForm } from "./logic";

describe("netStateWords", () => {
  it("maps states to words", () => {
    expect(netStateWords("sta_connected").label).toBe("Connected");
    expect(netStateWords("sta_connecting").label).toBe("Connecting");
    expect(netStateWords("ap_only").label).toBe("Setup AP only (not on Wi-Fi)");
    expect(netStateWords("apsta_recovery").label).toBe("Recovery: Setup AP is on");
    expect(netStateWords("idle").label).toBe("Idle");
    expect(netStateWords("weird").label).toBe("weird");
  });
});

describe("wifiChangeSentence", () => {
  it("is null when absent or none", () => {
    expect(wifiChangeSentence(undefined)).toBeNull();
    expect(wifiChangeSentence({ result: "none" })).toBeNull();
  });
  it("words failures", () => {
    expect(wifiChangeSentence({ result: "failed", reason: "auth", restored_previous: true })).toBe("Last change failed: wrong password; kept the old network.");
    expect(wifiChangeSentence({ result: "failed", reason: "no_ap" })).toBe("Last change failed: network not found.");
    expect(wifiChangeSentence({ result: "failed", reason: "no_ip" })).toContain("no address");
    expect(wifiChangeSentence({ result: "failed", reason: "timeout" })).toContain("timed out");
    expect(wifiChangeSentence({ result: "failed", reason: "connect_failed" })).toContain("could not connect");
    expect(wifiChangeSentence({ result: "failed", reason: "save_failed" })).toContain("could not save");
    expect(wifiChangeSentence({ result: "failed", reason: "bogus" as never })).toBe("Last change failed: unknown.");
    expect(wifiChangeSentence({ result: "failed" })).toBe("Last change failed: unknown.");
  });
  it("words ok and testing", () => {
    expect(wifiChangeSentence({ result: "ok", ssid: "Home" })).toContain('"Home"');
    expect(wifiChangeSentence({ result: "testing" })).toContain("Testing");
  });
});

describe("MQTT validation", () => {
  it("validates the URI", () => {
    expect(validateMqttUri("")).toBe("uri required (mqtt://host:1883)");
    expect(validateMqttUri("mqtt://192.168.1.10:1883")).toBeNull();
    expect(validateMqttUri("mqtts://broker.local")).toBeNull();
    expect(validateMqttUri("http://x")).not.toBeNull();
    expect(validateMqttUri("mqtt://")).not.toBeNull();
    expect(validateMqttUri("mqtt://host:99999")).toMatch(/port/);
    expect(validateMqttUri("mqtt://host name")).not.toBeNull();
  });
  it("validates the root", () => {
    expect(validateMqttRoot("")).toBeNull();
    expect(validateMqttRoot("home/devices_1-a")).toBeNull();
    expect(validateMqttRoot("bad root")).not.toBeNull();
    expect(validateMqttRoot("a#b")).not.toBeNull();
  });
  it("previews the prefix", () => {
    expect(mqttPrefixPreview("devices", "Workshop_node")).toBe("devices/Workshop_node");
    expect(mqttPrefixPreview("", "x")).toBe("devices/x");
    expect(mqttPrefixPreview("/a/", "x")).toBe("a/x");
  });
});

describe("buildMqttConfigure", () => {
  const current = { uri: "mqtt://10.0.0.1:1883", root: "devices" };
  const form: MqttForm = { uri: current.uri, root: "devices", changeCreds: false, user: "", password: "" };
  it("returns null when nothing changed", () => {
    expect(buildMqttConfigure(form, current)).toBeNull();
    expect(buildMqttConfigure({ ...form, root: "" }, current)).toBeNull();
  });
  it("sends only changed fields", () => {
    expect(buildMqttConfigure({ ...form, root: "home" }, current)).toEqual({ cmd: "mqtt.configure", root: "home" });
    expect(buildMqttConfigure({ ...form, uri: " mqtt://b:1883 " }, current)).toEqual({ cmd: "mqtt.configure", uri: "mqtt://b:1883" });
  });
  it("ignores typed credentials unless the box is checked", () => {
    expect(buildMqttConfigure({ ...form, user: "u", password: "p" }, current)).toBeNull();
    const b = buildMqttConfigure({ ...form, changeCreds: true, user: "u", password: "p" }, current);
    expect(b).toEqual({ cmd: "mqtt.configure", user: "u", password: "p" });
  });
  it("sends an empty user string to clear credentials", () => {
    expect(buildMqttConfigure({ ...form, changeCreds: true }, current)).toEqual({ cmd: "mqtt.configure", user: "", password: "" });
  });
});

describe("validateApPassword", () => {
  it("checks length and confirmation", () => {
    expect(validateApPassword("short")).not.toBeNull();
    expect(validateApPassword("12345678")).toBeNull();
    expect(validateApPassword("x".repeat(63))).toBeNull();
    expect(validateApPassword("x".repeat(64))).not.toBeNull();
    expect(validateApPassword("12345678", "1234567")).toMatch(/match/);
    expect(validateApPassword("12345678", "12345678")).toBeNull();
  });
});
