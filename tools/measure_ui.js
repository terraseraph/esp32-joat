// Report raw and gzip-9 size of UI html files, with the /*MOCK*/ block removed.
// Usage: node tools/measure_ui.js [web/proto/index.html ...]
const fs = require("fs"), zlib = require("zlib");
const paths = process.argv.slice(2).length ? process.argv.slice(2) : ["web/source/index.html"];
for (const p of paths) {
  const s = fs.readFileSync(p, "utf8").replace(/\/\*MOCK\*\/[\s\S]*?\/\*\/MOCK\*\/\n?/, "");
  const b = Buffer.from(s);
  console.log(`${p}: raw ${b.length} B, gzip-9 ${zlib.gzipSync(b, { level: 9 }).length} B`);
}
