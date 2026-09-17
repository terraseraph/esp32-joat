"use strict";

const fingerprint = require("./fingerprint");
const http = require("./http");

function parseTxt(data) {
  const out = {};
  const parts = Array.isArray(data) ? data : data != null ? [data] : [];
  for (const p of parts) {
    const s = Buffer.isBuffer(p) ? p.toString("utf8") : String(p);
    const i = s.indexOf("=");
    if (i > 0) {
      out[s.slice(0, i)] = s.slice(i + 1);
    }
  }
  return out;
}

function looksLikeOursTxt(txt) {
  return (
    txt.openapi === "/api/v1/openapi.json" ||
    txt.api === "/api/v1" ||
    (typeof txt.id === "string" && txt.id.length === 12) ||
    (typeof txt.board === "string" && txt.board.indexOf("esp32") === 0)
  );
}

function recordA(answers, ips) {
  for (const a of answers || []) {
    if (!a) {
      continue;
    }
    if (a.type === "A" && a.data) {
      const ip = typeof a.data === "string" ? a.data : null;
      if (ip && ips.indexOf(ip) < 0) {
        ips.push(ip);
      }
    }
  }
}

function mdnsCandidateIps(timeoutMs) {
  return new Promise((resolve) => {
    let mdns;
    try {
      mdns = require("multicast-dns")();
    } catch {
      resolve([]);
      return;
    }
    const ips = [];
    const prefer = [];
    const onResponse = (res) => {
      const chunks = [].concat(res.answers || [], res.additionals || []);
      let ours = false;
      for (const a of chunks) {
        if (a && a.type === "PTR") {
          const name = String(a.name || "");
          if (name.indexOf("_de-esp32._tcp") >= 0) {
            ours = true;
          }
        }
        if (a && a.type === "TXT" && looksLikeOursTxt(parseTxt(a.data))) {
          ours = true;
        }
      }
      const bucket = ours ? prefer : ips;
      recordA(chunks, bucket);
    };
    mdns.on("response", onResponse);
    mdns.on("error", () => {});
    try {
      mdns.query({
        questions: [
          { name: "_de-esp32._tcp.local", type: "PTR" },
          { name: "_http._tcp.local", type: "PTR" },
        ],
      });
    } catch {
      try {
        mdns.destroy();
      } catch {
        /* ignore */
      }
      resolve([]);
      return;
    }
    setTimeout(() => {
      try {
        mdns.removeListener("response", onResponse);
        mdns.destroy();
      } catch {
        /* ignore */
      }
      const out = prefer.slice();
      for (const ip of ips) {
        if (out.indexOf(ip) < 0) {
          out.push(ip);
        }
      }
      resolve(out);
    }, timeoutMs);
  });
}

function mergeVia(a, b) {
  if (!a) {
    return b;
  }
  if (!b || a === b) {
    return a;
  }
  return `${a}+${b}`;
}

function mergeDevice(map, dev) {
  if (!dev) {
    return;
  }
  if (dev.id && dev.topic_id && map.has(`topic:${dev.topic_id}`)) {
    const prev = map.get(`topic:${dev.topic_id}`);
    map.delete(`topic:${dev.topic_id}`);
    const cur = map.get(dev.id) || {};
    map.set(dev.id, Object.assign({}, prev, cur, dev, { via: mergeVia(mergeVia(prev.via, cur.via), dev.via) }));
    return;
  }
  if (!dev.id && dev.topic_id) {
    for (const [k, prev] of map) {
      if (prev.topic_id === dev.topic_id || k === `topic:${dev.topic_id}`) {
        map.set(k, Object.assign({}, prev, dev, { via: mergeVia(prev.via, dev.via) }));
        return;
      }
    }
  }
  let key = dev.id || "";
  if (!key && dev.topic_id) {
    key = `topic:${dev.topic_id}`;
  }
  if (!key && dev.ip) {
    key = `ip:${dev.ip}`;
  }
  if (!key) {
    return;
  }
  const prev = map.get(key) || {};
  map.set(key, Object.assign({}, prev, dev, { via: mergeVia(prev.via, dev.via) }));
}

async function probeIp(ip) {
  try {
    const st = await http.getStatus(ip, 80, 800);
    if (!fingerprint.isOurs(st)) {
      return null;
    }
    return fingerprint.summarize(ip, st, "mdns+http");
  } catch {
    return null;
  }
}

function mqttDiscover(brokerNode, mqttRoot, timeoutMs) {
  const host = brokerNode.broker || brokerNode.host;
  if (!host) {
    return Promise.resolve([]);
  }
  let mqtt;
  try {
    mqtt = require("mqtt");
  } catch {
    return Promise.resolve([]);
  }
  const root = mqttRoot || "devices";
  const creds = brokerNode.credentials || {};
  const client = mqtt.connect({
    host,
    port: Number(brokerNode.port) || 1883,
    protocol: brokerNode.usetls ? "mqtts" : "mqtt",
    username: creds.user || creds.username,
    password: creds.password,
    clientId: `de-esp32-scan-${process.pid}-${Date.now()}`,
    connectTimeout: Math.min(timeoutMs, 2500),
    reconnectPeriod: 0,
    rejectUnauthorized: false,
  });
  const found = new Map();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        client.end(true);
      } catch {
        /* ignore */
      }
      resolve([...found.values()]);
    };
    const t = setTimeout(finish, timeoutMs);
    client.on("error", () => {
      clearTimeout(t);
      finish();
    });
    client.on("connect", () => {
      client.subscribe([`${root}/+/api`, `${root}/+/availability`], { qos: 0 }, () => {});
    });
    client.on("message", (topic, payload) => {
      const parts = String(topic).split("/");
      const kind = parts[parts.length - 1];
      const topicId = parts.length >= 2 ? parts[parts.length - 2] : "";
      if (kind === "availability") {
        const online = String(payload).trim() === "online";
        mergeDevice(found, {
          id: "",
          topic_id: topicId,
          mqtt_root: root,
          mqtt_prefix: `${root}/${topicId}`,
          availability: online ? "online" : "offline",
          via: "mqtt",
        });
        return;
      }
      if (kind !== "api") {
        return;
      }
      let body;
      try {
        body = JSON.parse(String(payload));
      } catch {
        return;
      }
      if (!body || typeof body !== "object") {
        return;
      }
      mergeDevice(found, {
        ip: "",
        id: body.id || "",
        name: body.name || "",
        topic_id: body.topic_id || topicId,
        fw: body.fw || "",
        mqtt_prefix: body.prefix || `${root}/${body.topic_id || topicId}`,
        mqtt_root: body.root || root,
        via: "mqtt",
      });
    });
  });
}

async function scan(opts) {
  opts = opts || {};
  const timeoutMs = opts.timeoutMs || 2500;
  const map = new Map();
  const ips = await mdnsCandidateIps(timeoutMs);
  const probed = await Promise.all(ips.map(probeIp));
  for (const d of probed) {
    mergeDevice(map, d);
  }
  if (opts.host) {
    const one = await probeIp(http.normalizeHost(opts.host)).catch(() => null);
    if (one) {
      one.via = mergeVia(one.via, "http");
      mergeDevice(map, one);
    }
  }
  if (opts.broker) {
    const mqttDevs = await mqttDiscover(opts.broker, opts.mqttRoot || "devices", timeoutMs);
    for (const d of mqttDevs) {
      mergeDevice(map, d);
    }
  }
  return [...map.values()].sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
}

module.exports = { parseTxt, looksLikeOursTxt, scan, mergeDevice };
