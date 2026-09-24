"use strict";

const http = require("../lib/http");

function parsePins(raw) {
  if (raw && typeof raw === "object") {
    return raw;
  }
  try {
    const o = JSON.parse(raw || "{}");
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
}

function samePins(a, b) {
  const left = parsePins(a);
  const right = parsePins(b);
  const keys = Object.keys(left).concat(Object.keys(right));
  const seen = {};
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (seen[k]) {
      continue;
    }
    seen[k] = 1;
    if (Number(left[k]) !== Number(right[k])) {
      return false;
    }
  }
  return true;
}

module.exports = function (RED) {
  function ModuleNode(n) {
    RED.nodes.createNode(this, n);
    const node = this;
    node.device = RED.nodes.getNode(n.device);
    node.modType = n.modType || "";
    node.modId = (n.modId || "").trim();
    node.bus = n.bus || "";
    node.pins = parsePins(n.pins);
    node.install = n.install !== false;

    if (!node.device || !node.modType || !node.modId) {
      node.status({ fill: "red", shape: "ring", text: "no device/module" });
      return;
    }

    const showState = (state, sendIt) => {
      const known = !!(state && (state.id || state.type || Object.prototype.hasOwnProperty.call(state, "present")));
      const present = !!(state && state.present);
      const uid = state && state.uid ? String(state.uid) : "";
      const text = !known ? "scanning" : present ? uid || "tag" : "no tag";
      node.status({
        fill: present ? "green" : "blue",
        shape: "dot",
        text: node.modId + " · " + text,
      });
      if (sendIt && known) {
        node.send({
          payload: { id: node.modId, present, uid },
          topic: node.modId,
          data: state,
        });
      }
    };

    const onEv = (ev) => {
      if (ev.id !== node.modId) {
        return;
      }
      showState(ev.data || ev, true);
    };

    const start = async () => {
      if (node.install) {
        const listed = await http.postCommand(node.device.host, node.device.port, { cmd: "module.list" });
        const mods = (listed && listed.result && listed.result.modules) || [];
        const values = Object.keys(node.pins).map((k) => Number(node.pins[k]));
        const dup = values.filter((g, i) => values.indexOf(g) !== i);
        if (dup.length) {
          node.warn("module pins must be unique");
          node.status({ fill: "yellow", shape: "ring", text: "pick the bus again — pins overlap" });
          node.device.subscribeModule(node.modId, node, onEv);
          return;
        }
        const cur = mods.find((m) => m.id === node.modId);
        if (cur && cur.type === node.modType && cur.bus === node.bus && samePins(cur.pins, node.pins)) {
          showState(cur.state, true);
        } else if (cur) {
          node.warn(node.modId + " is already installed with different pins");
          node.status({ fill: "yellow", shape: "ring", text: "pins differ — left installed" });
        } else {
          const res = await http.postCommand(node.device.host, node.device.port, {
            cmd: "module.add",
            type: node.modType,
            id: node.modId,
            bus: node.bus,
            pins: node.pins,
          });
          if (res && res.ok === false) {
            node.warn(res.error || "module.add failed");
            node.status({ fill: "yellow", shape: "ring", text: res.error || "module.add failed" });
          } else {
            const added = (((res && res.result && res.result.modules) || []).find((m) => m.id === node.modId));
            showState(added && added.state, true);
          }
        }
      } else {
        showState(null, false);
      }
      node.device.subscribeModule(node.modId, node, onEv);
    };

    start().catch((err) => {
      node.error(err);
      node.status({ fill: "red", shape: "ring", text: err.message || "start failed" });
    });

    node.on("close", (done) => {
      if (node.device) {
        node.device.unsubscribeModule(node.modId, node);
      }
      done();
    });
  }

  RED.nodes.registerType("de-esp32-module", ModuleNode);
};
