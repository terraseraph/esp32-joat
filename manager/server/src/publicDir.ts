import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Where `main.ts` looks for the built SPA (server code cannot use `import.meta`).
 * First directory containing index.html wins:
 *   1. <dir of the running script>/public            bundled: dist/server.cjs -> dist/public
 *   2. <dir of the running script>/../../web/dist    dev:     server/src/main.ts -> web/dist
 *   3. <cwd>/web/dist                                dev, run from manager/
 * If none exists, (3) is returned so the server shows the "web app not built" page.
 * Electron passes `publicDir` to `start()` explicitly instead.
 */
export function resolvePublicDir(
  argv1: string | undefined,
  cwd: string = process.cwd(),
  exists: (file: string) => boolean = existsSync,
): string {
  const fallback = path.join(cwd, "web", "dist");
  const candidates: string[] = [];
  if (argv1) {
    const dir = path.dirname(path.resolve(argv1));
    candidates.push(path.join(dir, "public"), path.resolve(dir, "..", "..", "web", "dist"));
  }
  candidates.push(fallback);
  return candidates.find((dir) => exists(path.join(dir, "index.html"))) ?? fallback;
}
