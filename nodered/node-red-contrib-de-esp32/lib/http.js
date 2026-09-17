"use strict";

function normalizeHost(host) {
  return String(host || "")
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .trim();
}

function baseUrl(host, port) {
  const h = normalizeHost(host);
  const p = Number(port) || 80;
  if (!h) {
    throw new Error("host required");
  }
  return `http://${h}:${p}`;
}

async function fetchJson(url, opts) {
  const timeoutMs = (opts && opts.timeoutMs) || 2000;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: (opts && opts.method) || "GET",
      headers: Object.assign(
        { Accept: "application/json" },
        (opts && opts.body) ? { "Content-Type": "application/json" } : {},
        (opts && opts.headers) || {},
      ),
      body: opts && opts.body ? JSON.stringify(opts.body) : undefined,
      signal: ac.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const err = new Error((json && json.error) || `HTTP ${res.status}`);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  } catch (err) {
    if (err && (err.name === "AbortError" || err.code === "ABORT_ERR")) {
      const e = new Error("device HTTP timed out");
      e.cause = err;
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(t);
  }
}

function getStatus(host, port, timeoutMs) {
  return fetchJson(`${baseUrl(host, port)}/api/v1/status`, { timeoutMs: timeoutMs || 1500 });
}

function getHardware(host, port, timeoutMs) {
  return fetchJson(`${baseUrl(host, port)}/api/v1/hardware`, { timeoutMs: timeoutMs || 2500 });
}

function postCommand(host, port, body, timeoutMs) {
  return fetchJson(`${baseUrl(host, port)}/api/v1/command`, {
    method: "POST",
    body,
    timeoutMs: timeoutMs || 10000,
  });
}

module.exports = { normalizeHost, baseUrl, fetchJson, getStatus, getHardware, postCommand };
