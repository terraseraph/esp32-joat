import { promises as fs } from "node:fs";
import path from "node:path";
import { atomicWrite } from "../store/atomicWrite";

/**
 * The crash marker (`setup-recovery.json` in the data dir): written BEFORE a setup job moves this PC's Wi-Fi, so that after
 * a crash or power loss the next start can offer to put it back. It never holds a password.
 */
export interface SetupMarkerFile {
  v: 1;
  jobId: string;
  startedAt: string;
  /** The network this PC was on, null when it was not connected. */
  originalSsid: string | null;
  /** The saved profile that connection used (what `connect` needs), null when unknown. */
  originalProfile: string | null;
  /** Temporary profiles created by the job (listed BEFORE they are created). */
  profiles: string[];
}

export const MARKER_FILE = "setup-recovery.json";

export const markerPath = (dataDir: string): string => path.join(dataDir, MARKER_FILE);

export async function readMarker(dataDir: string, log: (msg: string) => void): Promise<SetupMarkerFile | null> {
  const file = markerPath(dataDir);
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") log(`setup: could not read ${MARKER_FILE}: ${(err as Error).message}`);
    return null;
  }
  try {
    const v = JSON.parse(text) as Partial<SetupMarkerFile>;
    if (typeof v !== "object" || v === null || v.v !== 1 || typeof v.jobId !== "string" || typeof v.startedAt !== "string" || !Array.isArray(v.profiles)) {
      throw new Error("unexpected content");
    }
    return {
      v: 1,
      jobId: v.jobId,
      startedAt: v.startedAt,
      originalSsid: typeof v.originalSsid === "string" ? v.originalSsid : null,
      originalProfile: typeof v.originalProfile === "string" ? v.originalProfile : null,
      profiles: v.profiles.filter((p): p is string => typeof p === "string"),
    };
  } catch (err) {
    // A file we cannot understand must not block setup forever: set it aside.
    log(`setup: ${MARKER_FILE} is not usable (${(err as Error).message}); moved aside`);
    await fs.rename(file, `${file}.bad`).catch(() => undefined);
    return null;
  }
}

export async function writeMarker(dataDir: string, marker: SetupMarkerFile): Promise<void> {
  await atomicWrite(markerPath(dataDir), JSON.stringify(marker, null, 2) + "\n");
}

export async function clearMarker(dataDir: string): Promise<void> {
  await fs.rm(markerPath(dataDir), { force: true });
}
