"use strict";

const PROMPT = "de-esp32>";

function createParser() {
  let carry = "";
  let sawPrompt = false;
  return {
    push(text) {
      carry += String(text).replace(/\r/g, "");
      const lines = [];
      let nl;
      while ((nl = carry.indexOf("\n")) >= 0) {
        const line = carry.slice(0, nl);
        carry = carry.slice(nl + 1);
        if (line.includes(PROMPT)) sawPrompt = true;
        lines.push(line);
      }
      if (carry.includes(PROMPT)) sawPrompt = true;
      return lines;
    },
    promptReady() {
      return sawPrompt;
    },
    consumePrompt() {
      if (!sawPrompt) return false;
      sawPrompt = false;
      const i = carry.indexOf(PROMPT);
      if (i >= 0) carry = carry.slice(i + PROMPT.length).replace(/^ /, "");
      return true;
    },
  };
}

function replyFromLine(line, corr) {
  const trimmed = String(line).trim();
  if (!trimmed.startsWith("{")) return null;
  let obj;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  if (obj.corr !== corr) return null;
  return obj;
}

function buildCommand(cmd, fields, corr) {
  return JSON.stringify(Object.assign({ cmd: cmd }, fields || {}, { corr: corr })) + "\n";
}

const api = { PROMPT, createParser, replyFromLine, buildCommand };

if (typeof module === "object" && module.exports) {
  module.exports = api;
} else {
  globalThis.DeEsp32Console = api;
}
