"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createParser, replyFromLine, buildCommand } = require("../lib/console.js");

describe("console parser", () => {
  it("pulls the matching corr reply out of mixed boot log", () => {
    const parser = createParser();
    const lines = [];
    lines.push(...parser.push("I (120) wifi: mode sta\n"));
    lines.push(
      ...parser.push(
        'I (400) cmd: done\n{"v":1,"ok":true,"corr":"name","result":{"name":"kitchen-relay"}}\n'
      )
    );
    lines.push(...parser.push("de-esp32> "));
    assert.equal(replyFromLine(lines[0], "name"), null);
    const reply = replyFromLine(lines[2], "name");
    assert.equal(reply.ok, true);
    assert.equal(reply.result.name, "kitchen-relay");
    assert.equal(parser.promptReady(), true);
  });

  it("ignores a non-JSON line and a JSON line for a different corr", () => {
    assert.equal(replyFromLine("unknown command", "wifi"), null);
    assert.equal(replyFromLine("not json {", "wifi"), null);
    const other = replyFromLine('{"v":1,"ok":true,"corr":"scan","result":[]}', "wifi");
    assert.equal(other, null);
    const wifi = replyFromLine(
      '{"v":1,"ok":false,"corr":"wifi","error":"wifi test failed; credentials not saved"}',
      "wifi"
    );
    assert.equal(wifi.ok, false);
    assert.match(wifi.error, /not saved/);
  });

  it("builds a single-line command with corr last", () => {
    const line = buildCommand("network.wifi.set", { ssid: "MyNet", password: "a b" }, "wifi");
    assert.ok(line.endsWith("\n"));
    const obj = JSON.parse(line.trim());
    assert.equal(obj.cmd, "network.wifi.set");
    assert.equal(obj.ssid, "MyNet");
    assert.equal(obj.password, "a b");
    assert.equal(obj.corr, "wifi");
  });
});
