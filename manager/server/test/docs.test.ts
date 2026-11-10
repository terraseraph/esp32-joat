import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { routes } from "../src/api";
import { VERSION } from "../src/version";

const root = path.resolve(import.meta.dirname, "..", "..");

test("manager/API.md has a '### METHOD /path' heading for every route in the table", () => {
  const md = readFileSync(path.join(root, "API.md"), "utf8");
  const headings = new Set(md.split(/\r?\n/).filter((l) => l.startsWith("### ")).map((l) => l.slice(4).trim()));
  const missing = routes.map((r) => `${r.method} ${r.path}`).filter((h) => !headings.has(h));
  assert.deepEqual(missing, [], `Add these headings (with a curl example) to manager/API.md: ${missing.join(", ")}`);
});

test("version.ts matches package.json", () => {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version: string };
  assert.equal(VERSION, pkg.version);
});
