"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { normalizeHost, baseUrl, fetchJson } = require("../lib/http");

describe("http helpers", () => {
  it("strips URL junk from pasted hosts", () => {
    assert.equal(normalizeHost("http://192.168.1.5/api"), "192.168.1.5");
    assert.equal(normalizeHost("192.168.1.5"), "192.168.1.5");
  });
  it("builds a v1 base", () => {
    assert.equal(baseUrl("192.168.1.5", 80), "http://192.168.1.5:80");
  });
  it("maps fetch AbortError to a timeout", async () => {
    const orig = global.fetch;
    global.fetch = (_url, opts) =>
      new Promise((_, reject) => {
        const fail = () => {
          const err = new Error("This operation was aborted");
          err.name = "AbortError";
          reject(err);
        };
        if (opts.signal && opts.signal.aborted) {
          fail();
          return;
        }
        if (opts.signal) {
          opts.signal.addEventListener("abort", fail, { once: true });
        }
      });
    try {
      await assert.rejects(() => fetchJson("http://192.168.1.5/x", { timeoutMs: 30 }), /device HTTP timed out/);
    } finally {
      global.fetch = orig;
    }
  });
});
