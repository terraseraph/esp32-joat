// Build the embedded UI: web/source/index.html -> web/dist/index.html (+ .gz, what the firmware embeds).
// The /*MOCK*/ ... /*/MOCK*/ block is a browser-only fake device; it is removed here.
// Usage: node tools/build_web.js
const fs = require("fs"), path = require("path"), zlib = require("zlib");
const root = path.resolve(__dirname, "..");
const src = path.join(root, "web", "source", "index.html");
const out = path.join(root, "web", "dist");
let html = fs.readFileSync(src, "utf8");
const stripped = html.replace(/\/\*MOCK\*\/[\s\S]*?\/\*\/MOCK\*\/\n?/, "");
if (stripped === html || /MOCK\*\//.test(stripped)) throw new Error("mock markers not found/balanced in " + src);
if (/\bmock\b/i.test(stripped.replace(/<!--[\s\S]*?-->/g, ""))) console.warn("warning: 'mock' still appears in the built page");
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "index.html"), stripped);
const gz = zlib.gzipSync(Buffer.from(stripped), { level: 9 });
fs.writeFileSync(path.join(out, "index.html.gz"), gz);
console.log(`web/dist/index.html ${Buffer.byteLength(stripped)} B, index.html.gz ${gz.length} B`);
