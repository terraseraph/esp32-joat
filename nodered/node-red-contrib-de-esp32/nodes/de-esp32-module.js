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

function listedModules(res) {
  return (res && res.result && res.result.modules) || [];
}

function statusInfo(state, modId) {
  if (state && Object.prototype.hasOwnProperty.call(state, "present")) {
    const present = !!state.present;
    const uid = state.uid ? String(state.uid) : "";
    return {
      known: true,
      present,
      text: present ? uid || "tag" : "no tag",
      payload: { id: modId, present, uid },
    };
  }
  if (state && (state.t_c != null || state.rh != null || state.p_hpa != null)) {
    const bits = [];
    if (state.t_c != null) {
      bits.push(state.t_c + "°C");
    }
    if (state.rh != null) {
      bits.push(state.rh + "%");
    }
    if (state.p_hpa != null) {
      bits.push(state.p_hpa + " hPa");
    }
    const ok = state.ok !== false;
    return {
      known: true,
      present: ok,
      text: ok ? bits.join(" · ") || "ready" : "sensor error",
      payload: Object.assign({ id: modId }, state),
    };
  }
  const known = !!(state && (state.id || state.type));
  if (!known) {
    return { known: false, present: false, text: "listening", payload: null };
  }
  const ok = !(state && state.ok === false);
  return {
    known: true,
    present: ok,
    text: ok ? "ready" : "error",
    payload: Object.assign({ id: modId }, state),
  };
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
    node.mode = n.mode === "installed" ? "installed" : "add";
    const listenOnly = node.mode === "installed" || node.install === false;

    if (!node.device || !node.modId || (!listenOnly && !node.modType)) {
      node.status({ fill: "red", shape: "ring", text: "no device/module" });
      return;
    }

    const showState = (state, sendIt) => {
      const info = statusInfo(state, node.modId);
      const text = info.known ? info.text : listenOnly ? "listening" : "scanning";
      node.status({
        fill: info.present ? "green" : "blue",
        shape: "dot",
        text: node.modId + " · " + text,
      });
      if (sendIt && info.known) {
        node.send({
          payload: info.payload,
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
      if (listenOnly) {
        try {
          const listed = await http.postCommand(node.device.host, node.device.port, { cmd: "module.list" });
          const cur = listedModules(listed).find((m) => m.id === node.modId);
          if (cur) {
            showState(cur.state, true);
          } else {
            node.status({ fill: "yellow", shape: "ring", text: node.modId + " · not installed" });
          }
        } catch (err) {
          node.status({ fill: "yellow", shape: "ring", text: err.message || "unreachable" });
        }
        node.device.subscribeModule(node.modId, node, onEv);
        return;
      }

      if (node.install) {
        const listed = await http.postCommand(node.device.host, node.device.port, { cmd: "module.list" });
        const mods = listedModules(listed);
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
