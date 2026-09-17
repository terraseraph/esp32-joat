"use strict";

const fs = require("fs");
const cmd = process.argv[2];
const inPath = process.argv[3];
const outPath = process.argv[4];
const raw = fs.readFileSync(inPath, "utf8").replace(/^\uFEFF/, "");
const j = JSON.parse(raw);
const flows = Array.isArray(j) ? j : j.flows;
if (!Array.isArray(flows)) {
  throw new Error("flows JSON missing array");
}
let out = flows;
if (cmd === "park") {
  out = flows.filter((n) => !String(n.type || "").startsWith("de-esp32"));
} else if (cmd !== "array") {
  throw new Error("usage: nodered_flows_park.js <park|array> <in> <out>");
}
fs.writeFileSync(outPath, JSON.stringify(out));
