import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Value } from "@sinclair/typebox/value";
import { atomicWrite } from "../store/atomicWrite";
import { BackupFileSchema, type BackupFile, type BackupMeta } from "../types/api-backups";

/**
 * Backups on disk: `<dir>/<id>.json`, one file each (the same JSON a download returns). The listing is an in-memory index of
 * metadata built at start from the files; a file that cannot be read is skipped (and logged), never overwritten.
 */

export const BACKUP_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export type ValidationResult = { ok: true; file: BackupFile } | { ok: false; reason: string };

function dedupe(items: Array<string | number>): string | null {
  const seen = new Set<string | number>();
  for (const i of items) {
    if (seen.has(i)) return String(i);
    seen.add(i);
  }
  return null;
}

/** Strict validation of an imported or stored backup. `reason` is plain words. */
export function validateBackup(input: unknown): ValidationResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, reason: "The file is not a backup: it does not contain a JSON object." };
  const o = input as Record<string, unknown>;
  if (o.kind !== "de-esp32-backup") return { ok: false, reason: "This file is not a de-esp32 backup (it has no \"kind\": \"de-esp32-backup\")." };
  if (o.v !== 1) return { ok: false, reason: `This backup has format version ${String(o.v)}, which this Manager cannot read (it reads version 1).` };
  if (!Value.Check(BackupFileSchema, input)) {
    const first = [...Value.Errors(BackupFileSchema, input)][0];
    const where = first?.path ? first.path.replace(/^\//, "").replace(/\//g, ".") : "the file";
    return { ok: false, reason: `The backup is damaged or incomplete at "${where}": ${first?.message ?? "invalid value"}.` };
  }
  const file = input as BackupFile;
  if (Number.isNaN(Date.parse(file.createdAt))) return { ok: false, reason: `The backup's date "${file.createdAt}" is not a valid date.` };
  const dupPin = dedupe(file.pins.map((p) => p.gpio));
  if (dupPin !== null) return { ok: false, reason: `GPIO ${dupPin} appears twice in the backup's pin list.` };
  const dupMod = dedupe(file.modules.map((m) => m.id));
  if (dupMod !== null) return { ok: false, reason: `The add-on "${dupMod}" appears twice in the backup.` };
  const dupRule = dedupe(file.rules.map((r) => r.id));
  if (dupRule !== null) return { ok: false, reason: `The rule "${dupRule}" appears twice in the backup.` };
  return { ok: true, file };
}

function metaOf(id: string, file: BackupFile, size: number): BackupMeta {
  return {
    id,
    createdAt: file.createdAt,
    source: { id: file.source.id, name: file.source.name, app_version: file.source.app_version },
    name: file.name,
    counts: { pins: file.pins.length, modules: file.modules.length, rules: file.rules.length },
    gaps: [...file.gaps],
    size,
    note: file.note ?? "",
  };
}

export interface BackupStore {
  /** Newest first; optionally only backups made from one device. */
  list(deviceId?: string): BackupMeta[];
  meta(id: string): BackupMeta | undefined;
  /** The stored file; undefined for an unknown id. */
  read(id: string): Promise<BackupFile | undefined>;
  /** Store a new backup under a fresh id. */
  add(file: BackupFile): Promise<BackupMeta>;
  setNote(id: string, note: string): Promise<BackupMeta | undefined>;
  remove(id: string): Promise<boolean>;
  /** Wait for pending writes. */
  flush(): Promise<void>;
}

function newId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "");
  return `bk_${stamp}_${randomBytes(3).toString("hex")}`;
}

export async function createBackupStore(dir: string, log: (msg: string) => void = () => {}): Promise<BackupStore> {
  await fs.mkdir(dir, { recursive: true });
  const index = new Map<string, BackupMeta>();
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };
  const fileOf = (id: string): string => path.join(dir, `${id}.json`);

  for (const name of await fs.readdir(dir)) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -5);
    if (!BACKUP_ID_RE.test(id)) continue;
    try {
      const text = await fs.readFile(path.join(dir, name), "utf8");
      const v = validateBackup(JSON.parse(text));
      if (!v.ok) throw new Error(v.reason);
      index.set(id, metaOf(id, v.file, Buffer.byteLength(text)));
    } catch (err) {
      log(`backups: skipping ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    list(deviceId) {
      const all = [...index.values()].filter((m) => deviceId === undefined || m.source.id === deviceId);
      return all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1));
    },
    meta: (id) => index.get(id),
    async read(id) {
      if (!BACKUP_ID_RE.test(id) || !index.has(id)) return undefined;
      try {
        return JSON.parse(await fs.readFile(fileOf(id), "utf8")) as BackupFile;
      } catch {
        return undefined;
      }
    },
    add(file) {
      return serial(async () => {
        const id = newId(new Date());
        const text = `${JSON.stringify(file, null, 2)}\n`;
        await atomicWrite(fileOf(id), text);
        const meta = metaOf(id, file, Buffer.byteLength(text));
        index.set(id, meta);
        return meta;
      });
    },
    setNote(id, note) {
      return serial(async () => {
        if (!index.has(id)) return undefined;
        const file = JSON.parse(await fs.readFile(fileOf(id), "utf8")) as BackupFile;
        if (note) file.note = note;
        else delete file.note;
        const text = `${JSON.stringify(file, null, 2)}\n`;
        await atomicWrite(fileOf(id), text);
        const meta = metaOf(id, file, Buffer.byteLength(text));
        index.set(id, meta);
        return meta;
      });
    },
    remove(id) {
      return serial(async () => {
        if (!index.has(id)) return false;
        await fs.rm(fileOf(id), { force: true });
        index.delete(id);
        return true;
      });
    },
    flush: async () => {
      await chain;
    },
  };
}
