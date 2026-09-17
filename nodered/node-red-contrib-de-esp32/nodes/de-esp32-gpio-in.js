"use strict";

function pinBody(n, gpio) {
  const mode = n.pinMode === "adc" ? "adc" : "in";
  const pin = {
    gpio,
    mode,
    name: n.pinName || `gpio_${gpio}`,
  };
  if (mode === "in") {
    pin.irq = true;
    pin.debounce_ms = Number(n.debounceMs);
    if (!Number.isFinite(pin.debounce_ms)) {
      pin.debounce_ms = 50;
    }
    pin.pull_up = !!n.pullUp;
    pin.invert = !!n.invert;
  } else {
    pin.sample_ms = Number(n.sampleMs);
    pin.hysteresis_mv = Number(n.hysteresisMv);
    pin.smooth = Number(n.smooth);
    if (!Number.isFinite(pin.sample_ms)) {
      pin.sample_ms = 50;
    }
    if (!Number.isFinite(pin.hysteresis_mv)) {
      pin.hysteresis_mv = 20;
    }
    if (!Number.isFinite(pin.smooth)) {
      pin.smooth = 70;
    }
  }
  return pin;
}

module.exports = function (RED) {
  function GpioInNode(n) {
    RED.nodes.createNode(this, n);
    const node = this;
    node.device = RED.nodes.getNode(n.device);
    if (n.gpio === "" || n.gpio == null || Number.isNaN(Number(n.gpio))) {
      node.status({ fill: "red", shape: "ring", text: "no device/gpio" });
      return;
    }
    node.gpio = Number(n.gpio);
    node.configure = n.configure !== false;
    node.pinMode = n.pinMode === "adc" ? "adc" : "in";

    if (!node.device) {
      node.status({ fill: "red", shape: "ring", text: "no device/gpio" });
      return;
    }

    const onEv = (ev) => {
      node.status({ fill: "green", shape: "dot", text: `GPIO ${node.gpio}: ${ev.value}` });
      node.send({
        payload: ev.value,
        gpio: ev.gpio,
        mode: ev.mode,
        topic: ev.id || `gpio_${ev.gpio}`,
        data: ev.data,
      });
    };

    const start = async () => {
      if (node.configure) {
        try {
          const res = await node.device.command({
            cmd: "pin.configure",
            pin: pinBody(n, node.gpio),
          });
          if (res && res.ok === false) {
            node.warn(res.error || "pin.configure failed");
            node.status({ fill: "yellow", shape: "ring", text: res.error || "configure failed" });
          }
        } catch (err) {
          node.warn(err.message || err);
          node.status({ fill: "yellow", shape: "ring", text: err.message || "configure failed" });
        }
      }
      node.device.subscribeGpio(node.gpio, node, onEv);
      node.status({
        fill: node.device.isLive() ? "green" : "yellow",
        shape: "ring",
        text: `${node.pinMode === "adc" ? "ADC" : "GPIO"} ${node.gpio}`,
      });
    };

    start().catch((err) => {
      node.error(err);
      node.status({ fill: "red", shape: "ring", text: err.message || "start failed" });
    });

    node.on("close", (done) => {
      if (node.device) {
        node.device.unsubscribeGpio(node.gpio, node);
      }
      done();
    });
  }

  RED.nodes.registerType("de-esp32-gpio-in", GpioInNode);
};
