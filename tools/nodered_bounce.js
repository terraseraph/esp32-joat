"use strict";

const fs = require("fs");
const flows = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const tab = "deesp32restarttab";
const inj = "deesp32restartinj";
const exe = "deesp32restartexec";
const rest = flows.filter((n) => n.id !== tab && n.id !== inj && n.id !== exe);
rest.push({
  id: tab,
  type: "tab",
  label: "de-esp32 restart once",
  disabled: false,
  info: "",
});
rest.push({
  id: inj,
  type: "inject",
  z: tab,
  name: "bounce node-red",
  props: [{ p: "payload" }],
  repeat: "",
  crontab: "",
  once: true,
  onceDelay: 0.5,
  topic: "",
  payload: "",
  payloadType: "date",
  x: 160,
  y: 80,
  wires: [[exe]],
});
rest.push({
  id: exe,
  type: "exec",
  z: tab,
  command: "sleep 8; killall -INT node; killall -INT node-red; true",
  addpay: "",
  append: "",
  useSpawn: false,
  timer: "0",
  winHide: false,
  oldrc: false,
  name: "delayed SIGINT node",
  x: 430,
  y: 80,
  wires: [[], [], []],
});
fs.writeFileSync(process.argv[3], JSON.stringify(rest));
