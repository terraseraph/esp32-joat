"use strict";

const WebSocket = require("ws");
const discover = require("../lib/discover");
const fingerprint = require("../lib/fingerprint");
const http = require("../lib/http");
const io = require("../lib/io");
const devkitc = require("../lib/devkitc-hardware");

function asyncRoute(fn) {
  return (req, res) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      res.status(500).json({ error: err.message || String(err) });
    });
  };
}

function hostFromReq(req, RED) {
  let host = req.query.host || (req.body && req.body.host);
  let port = req.query.port || (req.body && req.body.port) || 80;
  const id = req.query.id || (req.body && req.body.id);
  if ((!host || !host.length) && id && RED) {
    const n = RED.nodes.getNode(id);
    if (n) {
      host = n.host;
      port = n.port;
    }
  }
  return { host: http.normalizeHost(host), port: Number(port) || 80 };
}

module.exports = function (RED) {
  function DeviceNode(n) {
    RED.nodes.createNode(this, n);
    this.host = http.normalizeHost(n.host);
    this.port = Number(n.port) || 80;
    this.deviceId = n.deviceId || "";
    this.deviceName = n.deviceName || n.name || "";
    this.topicId = n.topicId || "";
    this.mqttRoot = n.mqttRoot || "devices";
    this.brokerConn = n.broker ? RED.nodes.getNode(n.broker) : null;

    this._gpioListeners = new Map();
    this._ws = null;
    this._wsTimer = null;
    this._wsWanted = false;
    this._mqttTopic = "";
    this._live = false;
    const self = this;

    this.mqttPrefix = function () {
      const slug = self.topicId || self.deviceId;
      if (!slug) {
        return "";
      }
      return `${self.mqttRoot}/${slug}`;
    };

    this.command = function (body) {
      const prefix = self.mqttPrefix();
      if (self.brokerConn && prefix && typeof self.brokerConn.publish === "function") {
        try {
          self.brokerConn.publish({
            topic: `${prefix}/system/command`,
            payload: JSON.stringify(body),
            qos: 1,
            retain: false,
          });
          return Promise.resolve({ ok: true, via: "mqtt" });
        } catch (err) {
          self.warn(`MQTT command failed, HTTP fallback: ${err.message || err}`);
        }
      }
      return http.postCommand(self.host, self.port, body);
    };

    this.fetchHardware = function () {
      return http.getHardware(self.host, self.port);
    };

    this.fetchStatus = function () {
      return http.getStatus(self.host, self.port);
    };

    this.isLive = function () {
      return self._live;
    };

    this.subscribeGpio = function (gpio, node, cb) {
      const g = Number(gpio);
      if (!self._gpioListeners.has(g)) {
        self._gpioListeners.set(g, new Map());
      }
      self._gpioListeners.get(g).set(node.id, cb);
      self._ensureLive();
    };

    this.unsubscribeGpio = function (gpio, node) {
      const g = Number(gpio);
      const m = self._gpioListeners.get(g);
      if (m) {
        m.delete(node.id);
        if (m.size === 0) {
          self._gpioListeners.delete(g);
        }
      }
      if (self._gpioListeners.size === 0) {
        self._stopLive();
      }
    };

    this._dispatchIo = function (raw) {
      const ev = io.parseIoMessage(raw);
      if (!ev) {
        return;
      }
      self._live = true;
      const m = self._gpioListeners.get(ev.gpio);
      if (!m) {
        return;
      }
      m.forEach((cb) => {
        try {
          cb(ev);
        } catch (err) {
          self.warn(err.message || err);
        }
      });
    };

    this._ensureLive = function () {
      if (self.brokerConn) {
        self._startMqtt();
        return;
      }
      self._wsWanted = true;
      self._startWs();
    };

    this._stopLive = function () {
      self._wsWanted = false;
      self._stopWs();
      self._stopMqtt();
      self._live = false;
    };

    this._startMqtt = function () {
      if (!self.brokerConn || self._mqttTopic) {
        return;
      }
      const prefix = self.mqttPrefix();
      if (!prefix) {
        self.warn("MQTT prefix unknown — set MAC id or topic id");
        return;
      }
      self._mqttTopic = `${prefix}/io`;
      try {
        self.brokerConn.register(self);
        self.brokerConn.subscribe(
          self._mqttTopic,
          1,
          (_topic, payload) => {
            self._dispatchIo(payload);
          },
          self.id,
        );
        self.command({ cmd: "io.hydrate" }).catch(() => {});
      } catch (err) {
        self.warn(`MQTT subscribe failed: ${err.message || err}`);
        self._mqttTopic = "";
      }
    };

    this._stopMqtt = function () {
      if (!self.brokerConn || !self._mqttTopic) {
        return;
      }
      try {
        self.brokerConn.unsubscribe(self._mqttTopic, self.id);
        self.brokerConn.deregister(self, () => {});
      } catch {
        /* ignore */
      }
      self._mqttTopic = "";
    };

    this._startWs = function () {
      if (!self._wsWanted || self._ws || !self.host) {
        return;
      }
      const url = `ws://${self.host}:${self.port}/api/v1/ws`;
      let ws;
      try {
        ws = new WebSocket(url, { handshakeTimeout: 4000 });
      } catch (err) {
        self.warn(err.message || err);
        self._scheduleWs();
        return;
      }
      self._ws = ws;
      ws.on("open", () => {
        self._live = true;
        self.command({ cmd: "io.hydrate" }).catch(() => {});
      });
      ws.on("message", (data) => {
        self._dispatchIo(data);
      });
      ws.on("error", () => {});
      ws.on("close", () => {
        if (self._ws === ws) {
          self._ws = null;
        }
        self._live = false;
        if (self._wsWanted) {
          self._scheduleWs();
        }
      });
    };

    this._scheduleWs = function () {
      if (self._wsTimer || !self._wsWanted) {
        return;
      }
      self._wsTimer = setTimeout(() => {
        self._wsTimer = null;
        self._startWs();
      }, 3000);
    };

    this._stopWs = function () {
      if (self._wsTimer) {
        clearTimeout(self._wsTimer);
        self._wsTimer = null;
      }
      if (self._ws) {
        try {
          self._ws.removeAllListeners();
          self._ws.close();
        } catch {
          /* ignore */
        }
        self._ws = null;
      }
    };

    this.on("close", (done) => {
      self._gpioListeners.clear();
      self._stopLive();
      done();
    });
  }

  RED.nodes.registerType("de-esp32-device", DeviceNode);

  RED.httpAdmin.get(
    "/de-esp32/scan",
    RED.auth.needsPermission("de-esp32-device.read"),
    asyncRoute(async (req, res) => {
      const brokerId = req.query.broker;
      const broker = brokerId ? RED.nodes.getNode(brokerId) : null;
      const devices = await discover.scan({
        timeoutMs: Number(req.query.timeout) || 2500,
        broker,
        mqttRoot: req.query.root || "devices",
        host: req.query.host,
      });
      res.json({ devices });
    }),
  );

  RED.httpAdmin.get(
    "/de-esp32/status",
    RED.auth.needsPermission("de-esp32-device.read"),
    asyncRoute(async (req, res) => {
      const { host, port } = hostFromReq(req, RED);
      const st = await http.getStatus(host, port);
      if (!fingerprint.isOurs(st)) {
        res.status(404).json({ error: "not a de-esp32 device" });
        return;
      }
      res.json(fingerprint.summarize(host, st, "http"));
    }),
  );

  RED.httpAdmin.get(
    "/de-esp32/pinout-template",
    RED.auth.needsPermission("de-esp32-device.read"),
    (req, res) => {
      const hw = devkitc.snapshot();
      hw.via = "devkitc-fallback";
      res.json(hw);
    },
  );

  RED.httpAdmin.get(
    "/de-esp32/hardware",
    RED.auth.needsPermission("de-esp32-device.read"),
    asyncRoute(async (req, res) => {
      const { host, port } = hostFromReq(req, RED);
      if (!host) {
        res.json(devkitc.withFallbackMeta(new Error("host required")));
        return;
      }
      try {
        const hw = await http.getHardware(host, port, 1200);
        if (hw && typeof hw === "object") {
          hw.via = "http";
        }
        res.json(hw);
      } catch (err) {
        res.json(devkitc.withFallbackMeta(err));
      }
    }),
  );

  RED.httpAdmin.post(
    "/de-esp32/command",
    RED.auth.needsPermission("de-esp32-device.write"),
    asyncRoute(async (req, res) => {
      const { host, port } = hostFromReq(req, RED);
      const body = Object.assign({}, req.body || {});
      delete body.host;
      delete body.port;
      delete body.id;
      res.json(await http.postCommand(host, port, body));
    }),
  );
};
