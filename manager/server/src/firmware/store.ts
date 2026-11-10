import { promises as fs } from "node:fs";
import path from "node:path";
import { atomicWrite } from "../store/atomicWrite";
import type { FirmwareImage, FirmwareImageSource } from "../types/api-firmware";
import { parseImage } from "./image";

/** The firmware library: `<dataDir>/firmware/<sha256>.bin` plus `index.json` (written atomically). */
export interface FirmwareStore {
  list(): FirmwareImage[];
  get(id: string): FirmwareImage | undefined;
  /** Absolute path of the stored file. */
  filePath(id: string): string;
  /** Validates (throws `ImageError`), stores, and returns the image and whether it was new. */
  add(buf: Buffer, filename: string, source: FirmwareImageSource): Promise<{ image: FirmwareImage; created: boolean }>;
  remove(id: string): Promise<boolean>;
}

const SAFE_ID = /^[0-9a-f]{64}$/;

function cleanFilename(name: string): string {
  const base = name.replace(/^.*[\\/]/, "").replace(/[^\w .()+-]/g, "_").trim().slice(0, 120);
  return base || "firmware.bin";
}

export async function createFirmwareStore(dataDir: string): Promise<FirmwareStore> {
  const dir = path.join(dataDir, "firmware");
  const indexFile = path.join(dir, "index.json");
  await fs.mkdir(dir, { recursive: true });
  let images: FirmwareImage[] = [];
  try {
    const parsed = JSON.parse(await fs.readFile(indexFile, "utf8")) as { images?: FirmwareImage[] };
    if (Array.isArray(parsed.images)) images = parsed.images.filter((i) => SAFE_ID.test(i.id));
  } catch {
    images = [];
  }
  // Forget entries whose file is gone.
  const present: FirmwareImage[] = [];
  for (const i of images) {
    try {
      await fs.access(path.join(dir, `${i.id}.bin`));
      present.push(i);
    } catch {
      /* file missing */
    }
  }
  images = present;

  let chain: Promise<unknown> = Promise.resolve();
  const save = (): Promise<void> => atomicWrite(indexFile, JSON.stringify({ v: 1, images }, null, 2) + "\n");
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };

  return {
    list: () => [...images].sort((a, b) => b.addedAt.localeCompare(a.addedAt)),
    get: (id) => images.find((i) => i.id === id),
    filePath(id) {
      if (!SAFE_ID.test(id)) throw new Error("bad image id");
      return path.join(dir, `${id}.bin`);
    },
    async add(buf, filename, source) {
      const info = parseImage(buf);
      return await serial(async () => {
        const existing = images.find((i) => i.id === info.sha256);
        if (existing) return { image: existing, created: false };
        await atomicWrite(path.join(dir, `${info.sha256}.bin`), buf);
        const image: FirmwareImage = {
          id: info.sha256,
          filename: cleanFilename(filename),
          size: info.size,
          version: info.version,
          project: info.project,
          date: info.date,
          time: info.time,
          idfVer: info.idfVer,
          chip: info.chip,
          source,
          addedAt: new Date().toISOString(),
        };
        images.push(image);
        await save();
        return { image, created: true };
      });
    },
    remove(id) {
      return serial(async () => {
        const i = images.findIndex((x) => x.id === id);
        if (i < 0) return false;
        images.splice(i, 1);
        await save();
        await fs.rm(path.join(dir, `${id}.bin`), { force: true });
        return true;
      });
    },
  };
}
