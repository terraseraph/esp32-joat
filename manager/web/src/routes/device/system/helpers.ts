import type { ImageState, MemoryInfo } from "@shared/device-api";
import type { Tone } from "../../../components/ui/Chip";

/** Longest device name the firmware accepts. */
export const NAME_MAX = 31;

/**
 * MQTT topic id the firmware derives from a name (spec 2.5 `identity.set_name`): spaces and dots become `_`,
 * everything outside `[A-Za-z0-9_-]` is dropped. An empty result falls back to `fallback` (the hostname).
 */
export function topicIdPreview(name: string, fallback = ""): string {
  const id = name.trim().replace(/[ .]/g, "_").replace(/[^A-Za-z0-9_-]/g, "");
  return id || fallback;
}

/** Validation message for a new device name, or null when it can be sent. */
export function validateName(name: string): string | null {
  const v = name.trim();
  if (!v) return "Enter a name.";
  if (v.length > NAME_MAX) return `Up to ${NAME_MAX} characters.`;
  return null;
}

// ---- logs -----------------------------------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** Remove ANSI escape sequences (colour codes the firmware's logger adds). */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

export type LogLevel = "e" | "w" | "i" | "d" | "v" | "other";

/** ESP-IDF line prefix `E (123) tag: ...` to a level; anything else is `other`. */
export function classifyLogLine(line: string): LogLevel {
  const m = /^([EWIDV]) \(/.exec(line);
  if (!m) return "other";
  return m[1]!.toLowerCase() as LogLevel;
}

export interface LogLine {
  text: string;
  level: LogLevel;
}

export function parseLogs(lines: readonly string[]): LogLine[] {
  return lines.map((raw) => {
    const text = stripAnsi(raw);
    return { text, level: classifyLogLine(text) };
  });
}

/** CSS class (from tokens.css) for a level. */
export function logLevelClass(level: LogLevel): string {
  switch (level) {
    case "e":
      return "lv-e";
    case "w":
      return "lv-w";
    case "d":
    case "v":
      return "lv-d";
    default:
      return "lv-i";
  }
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** `<title>-logs-YYYYMMDD-HHMMSS.txt`, safe for file systems. */
export function logFileName(title: string, at: Date = new Date()): string {
  const slug = title.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "device";
  const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  return `${slug}-logs-${stamp}.txt`;
}

// ---- reset reason / boot state -------------------------------------------------------------------------------

const RESET_REASONS: Record<number, string> = {
  0: "Unknown",
  1: "Power-on",
  2: "External pin",
  3: "Software restart",
  4: "Exception / panic",
  5: "Interrupt watchdog",
  6: "Task watchdog",
  7: "Other watchdog",
  8: "Wake from deep sleep",
  9: "Brownout",
  10: "SDIO",
};

/** `esp_reset_reason_t` to words. */
export function resetReasonLabel(code: number | null | undefined): string {
  if (code == null) return "-";
  return RESET_REASONS[code] ?? `Unknown (${code})`;
}

/** Reset reasons that point to a fault rather than a normal start. */
export function resetReasonTone(code: number | null | undefined): Tone | undefined {
  if (code === 4 || (code != null && code >= 5 && code <= 7) || code === 9) return "warn";
  return undefined;
}

export function bootStateTone(state: string | null | undefined): Tone {
  if (state === "healthy") return "ok";
  if (state === "safe_mode") return "bad";
  return "warn";
}

export function bootStateLabel(state: string | null | undefined): string {
  if (!state) return "-";
  if (state === "healthy") return "Healthy";
  if (state === "safe_mode") return "Safe mode";
  return state.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

// ---- memory ---------------------------------------------------------------------------------------------------

/** Used share of a pool in percent (0 to 100); 0 when the total is unknown. */
export function usedPercent(used: number, total: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.min(100, Math.max(0, (used / total) * 100));
}

/** Largest free block under which adding add-ons may fail (spec 4.4 prototype). */
export const LOW_BLOCK_BYTES = 48 * 1024;
/** Task stacks with less than this left are highlighted. */
export const LOW_STACK_BYTES = 1500;

export function isLowBlock(largest: number): boolean {
  return largest < LOW_BLOCK_BYTES;
}
export function isLowStack(bytes: number): boolean {
  return bytes < LOW_STACK_BYTES;
}

export function pressureTone(p: MemoryInfo["pressure"] | string | null | undefined): Tone {
  if (p === "ok") return "ok";
  if (p === "warn") return "warn";
  if (p === "critical") return "bad";
  return "off";
}

export function pressureLabel(p: string | null | undefined): string {
  if (p === "ok") return "OK";
  if (p === "warn") return "Low";
  if (p === "critical") return "Critical";
  return "-";
}

// ---- firmware -------------------------------------------------------------------------------------------------

const IMAGE_STATE: Record<ImageState, { label: string; tone: Tone }> = {
  new: { label: "New, not started yet", tone: "acc" },
  pending_verify: { label: "Pending verify", tone: "warn" },
  valid: { label: "Valid", tone: "ok" },
  invalid: { label: "Invalid", tone: "bad" },
  aborted: { label: "Aborted", tone: "bad" },
  undefined: { label: "Unknown", tone: "off" },
};

export function imageStateInfo(s: string | null | undefined): { label: string; tone: Tone } {
  return (s && IMAGE_STATE[s as ImageState]) || { label: s || "-", tone: "off" };
}
