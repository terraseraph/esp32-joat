import { describe, expect, it } from "vitest";
import { filterLines } from "./LogsCard";
import {
  bootStateLabel,
  classifyLogLine,
  imageStateInfo,
  isLowBlock,
  isLowStack,
  logFileName,
  parseLogs,
  pressureTone,
  resetReasonLabel,
  stripAnsi,
  topicIdPreview,
  usedPercent,
  validateName,
} from "./helpers";

describe("topicIdPreview", () => {
  it("turns spaces and dots into underscores and drops other characters", () => {
    expect(topicIdPreview("Workshop node")).toBe("Workshop_node");
    expect(topicIdPreview("a.b c")).toBe("a_b_c");
    expect(topicIdPreview("Küche #1 (alt)")).toBe("Kche_1_alt");
    expect(topicIdPreview("ok-name_2")).toBe("ok-name_2");
  });
  it("falls back when nothing is left", () => {
    expect(topicIdPreview("###", "esp32-b3c4d5")).toBe("esp32-b3c4d5");
    expect(topicIdPreview("", "x")).toBe("x");
  });
});

describe("validateName", () => {
  it("accepts 1 to 31 characters", () => {
    expect(validateName("a")).toBeNull();
    expect(validateName("x".repeat(31))).toBeNull();
    expect(validateName("   ")).not.toBeNull();
    expect(validateName("x".repeat(32))).toMatch(/31/);
  });
});

describe("logs", () => {
  it("strips ANSI colour codes", () => {
    expect(stripAnsi("\u001b[0;32mI (312) boot: ok\u001b[0m")).toBe("I (312) boot: ok");
    expect(stripAnsi("plain")).toBe("plain");
  });
  it("classifies by ESP-IDF level prefix", () => {
    expect(classifyLogLine("E (1) a: b")).toBe("e");
    expect(classifyLogLine("W (1) a: b")).toBe("w");
    expect(classifyLogLine("I (1) a: b")).toBe("i");
    expect(classifyLogLine("D (1) a: b")).toBe("d");
    expect(classifyLogLine("V (1) a: b")).toBe("v");
    expect(classifyLogLine("boot: hello")).toBe("other");
    expect(classifyLogLine("Error (1)")).toBe("other");
  });
  it("classifies after stripping, and filters by level", () => {
    const lines = parseLogs(["\u001b[0;31mE (5) mqtt: error\u001b[0m", "W (6) x: warn", "I (7) y: info"]);
    expect(lines.map((l) => l.level)).toEqual(["e", "w", "i"]);
    expect(filterLines(lines, "e")).toHaveLength(1);
    expect(filterLines(lines, "w")).toHaveLength(2);
    expect(filterLines(lines, "all")).toHaveLength(3);
  });
  it("builds a safe file name with the device title and time", () => {
    expect(logFileName("Workshop node", new Date(2026, 10, 10, 9, 5, 7))).toBe("Workshop-node-logs-20261110-090507.txt");
    expect(logFileName("///", new Date(2026, 0, 2, 3, 4, 5))).toBe("device-logs-20260102-030405.txt");
  });
});

describe("labels", () => {
  it("maps esp_reset_reason_t", () => {
    expect(resetReasonLabel(1)).toBe("Power-on");
    expect(resetReasonLabel(3)).toBe("Software restart");
    expect(resetReasonLabel(4)).toBe("Exception / panic");
    expect(resetReasonLabel(6)).toBe("Task watchdog");
    expect(resetReasonLabel(9)).toBe("Brownout");
    expect(resetReasonLabel(10)).toBe("SDIO");
    expect(resetReasonLabel(42)).toBe("Unknown (42)");
    expect(resetReasonLabel(null)).toBe("-");
  });
  it("describes boot and image states", () => {
    expect(bootStateLabel("healthy")).toBe("Healthy");
    expect(bootStateLabel("safe_mode")).toBe("Safe mode");
    expect(imageStateInfo("pending_verify")).toEqual({ label: "Pending verify", tone: "warn" });
    expect(imageStateInfo("valid").tone).toBe("ok");
  });
});

describe("memory", () => {
  it("computes percentages and thresholds", () => {
    expect(usedPercent(176000, 327200)).toBeCloseTo(53.79, 1);
    expect(usedPercent(10, 0)).toBe(0);
    expect(usedPercent(500, 100)).toBe(100);
    expect(isLowBlock(40 * 1024)).toBe(true);
    expect(isLowBlock(88 * 1024)).toBe(false);
    expect(isLowStack(1204)).toBe(true);
    expect(isLowStack(1500)).toBe(false);
    expect(pressureTone("critical")).toBe("bad");
    expect(pressureTone("warn")).toBe("warn");
  });
});
