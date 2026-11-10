import type { WifiAdapter } from "../wifi/adapter";
import type { SetupMarkerFile } from "./marker";

export interface RestoreOptions {
  /** How long to wait for each attempt to rejoin the original network (default 25 s). */
  rejoinMs?: number;
  /** Attempts to rejoin (default 2). */
  attempts?: number;
  log?: (msg: string) => void;
}

export interface RestoreOutcome {
  ok: boolean;
  /** Plain words for a person. */
  message: string;
  /** Temporary profiles that could not be deleted. */
  remaining: string[];
}

const scrub = (text: string, secrets: readonly string[]): string => secrets.reduce((t, s) => (s.length >= 3 ? t.split(s).join("***") : t), text);

/**
 * Put this PC's Wi-Fi back the way the marker says: rejoin the remembered network, delete every temporary profile.
 * Never throws; the outcome says what is left. Used by the job's final path and by `POST /api/setup/recovery/restore`.
 */
export async function restoreNetwork(adapter: WifiAdapter, marker: SetupMarkerFile, opts: RestoreOptions = {}, secrets: readonly string[] = []): Promise<RestoreOutcome> {
  const log = opts.log ?? (() => {});
  const attempts = Math.max(1, opts.attempts ?? 2);
  const rejoinMs = opts.rejoinMs ?? 25_000;
  const original = marker.originalSsid;
  let rejoinNote = "";

  if (original !== null) {
    for (let i = 0; i < attempts; i++) {
      try {
        const now = await adapter.current();
        if (now.ssid === original) {
          rejoinNote = "";
          break;
        }
        await adapter.connect(marker.originalProfile ?? original, original, { timeoutMs: rejoinMs });
        rejoinNote = "";
        break;
      } catch (err) {
        rejoinNote = scrub(err instanceof Error ? err.message : String(err), secrets);
        log(`setup: rejoining "${original}" failed (attempt ${i + 1}/${attempts}): ${rejoinNote}`);
      }
    }
  }

  const remaining: string[] = [];
  for (const name of marker.profiles) {
    try {
      await adapter.deleteProfile(name);
    } catch (err) {
      remaining.push(name);
      log(`setup: could not delete temporary profile ${name}: ${scrub(err instanceof Error ? err.message : String(err), secrets)}`);
    }
  }

  let onOriginal = original === null;
  if (original !== null) {
    try {
      onOriginal = (await adapter.current()).ssid === original;
    } catch {
      onOriginal = false;
    }
  }

  if (onOriginal && remaining.length === 0) {
    return { ok: true, message: original !== null ? `This PC is back on "${original}".` : "The temporary Wi-Fi settings were removed.", remaining };
  }
  const parts: string[] = [];
  if (!onOriginal && original !== null) parts.push(`Could not rejoin "${original}". Use Restore network on the Discover page, or join it from the Windows Wi-Fi menu.`);
  if (remaining.length > 0) parts.push(`${remaining.length === 1 ? "A temporary Wi-Fi profile" : "Temporary Wi-Fi profiles"} could not be removed (${remaining.join(", ")}); delete them in the Windows Wi-Fi settings under "Manage known networks".`);
  if (rejoinNote && !onOriginal) parts.push(`(${rejoinNote})`);
  return { ok: false, message: parts.join(" "), remaining };
}
