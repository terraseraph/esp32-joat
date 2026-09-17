"use strict";

const { toLevel } = require("../lib/level");

function pinBody(n, gpio) {
  const mode = n.pinMode === "pwm" ? "pwm" : "out";
  const pin = {
    gpio,
    mode,
    name: n.pinName || `gpio_${gpio}`,
  };
  if (mode === "out") {
    pin.pull_up = !!n.pullUp;
    pin.invert = !!n.invert;
    pin.boot = Number(n.boot) ? 1 : 0;
  } else {
    pin.duty = Number(n.duty);
    pin.hz = Number(n.hz);
    if (!Number.isFinite(pin.duty)) {
      pin.duty = 0;
    }
    if (!Number.isFinite(pin.hz)) {
      pin.hz = 1000;
    }
  }
  return pin;
}

module.exports = function (RED) {
  function GpioOutNode(n) {
    RED.nodes.createNode(this, n);
    const node = this;
    node.device = RED.nodes.getNode(n.device);
    if (n.gpio === "" || n.gpio == null || Number.isNaN(Number(n.gpio))) {
      node.status({ fill: "red", shape: "ring", text: "no device/gpio" });
      return;
    }
    node.gpio = Number(n.gpio);
    node.configure = n.configure !== false;
    node.pinMode = n.pinMode === "pwm" ? "pwm" : "out";

    if (!node.device) {
      node.status({ fill: "red", shape: "ring", text: "no device/gpio" });
      return;
    }

    const start = async () => {
      if (!node.configure) {
        node.status({ fill: "green", shape: "ring", text: `GPIO ${node.gpio}` });
        return;
      }
      try {
        const res = await node.device.command({
          cmd: "pin.configure",
          pin: pinBody(n, node.gpio),
        });
        if (res && res.ok === false) {
          node.warn(res.error || "pin.configure failed");
          node.status({ fill: "yellow", shape: "ring", text: res.error || "configure failed" });
          return;
        }
        node.status({ fill: "green", shape: "ring", text: `${node.pinMode === "pwm" ? "PWM" : "GPIO"} ${node.gpio}` });
      } catch (err) {
        node.warn(err.message || err);
        node.status({ fill: "yellow", shape: "ring", text: err.message || "configure failed" });
      }
    };

    start().catch((err) => {
      node.error(err);
      node.status({ fill: "red", shape: "ring", text: err.message || "start failed" });
    });

    node.on("input", async (msg, send, done) => {
      const mode = node.pinMode;
      let value;
      if (mode === "pwm") {
        const raw = msg && msg.payload && typeof msg.payload === "object" && msg.payload.value != null
          ? msg.payload.value
          : msg.payload;
        value = Number(raw);
        if (!Number.isFinite(value)) {
          const err = new Error("PWM payload must be 0–1000");
          if (done) {
            done(err);
          } else {
            node.error(err, msg);
          }
          return;
        }
        if (value < 0) {
          value = 0;
        }
        if (value > 1000) {
          value = 1000;
        }
        value = Math.round(value);
      } else {
        value = toLevel(msg.payload);
        if (value == null) {
          const err = new Error("payload must be 0/1, true/false, on/off");
          if (done) {
            done(err);
          } else {
            node.error(err, msg);
          }
          return;
        }
      }
      try {
        const res = await node.device.command({
          cmd: "pin.set",
          gpio: node.gpio,
          value,
          mode,
        });
        if (res && res.ok === false) {
          throw new Error(res.error || "pin.set failed");
        }
        node.status({ fill: "green", shape: "dot", text: `${mode === "pwm" ? "PWM" : "GPIO"} ${node.gpio}: ${value}` });
        if (done) {
          done();
        }
      } catch (err) {
        node.status({ fill: "red", shape: "ring", text: err.message || "set failed" });
        if (done) {
          done(err);
        } else {
          node.error(err, msg);
        }
      }
    });
  }

  RED.nodes.registerType("de-esp32-gpio-out", GpioOutNode);
};
