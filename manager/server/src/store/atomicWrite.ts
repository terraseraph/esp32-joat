import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

async function renameWithRetry(from: string, to: string): Promise<void> {
  // Windows can briefly refuse to replace a file that antivirus/indexers have open.
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 5 || !code || !RETRY_CODES.has(code)) throw err;
      await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
    }
  }
}

/** Write `data` to `filePath` atomically: temp file in the same dir, fsync, rename over the target. */
export async function atomicWrite(filePath: string, data: string | Uint8Array): Promise<void> {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  const fh = await fs.open(tmp, "w");
  try {
    await fh.writeFile(data);
    await fh.sync();
  } catch (err) {
    await fh.close().catch(() => {});
    await fs.rm(tmp, { force: true });
    throw err;
  }
  await fh.close();
  try {
    await renameWithRetry(tmp, filePath);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}
