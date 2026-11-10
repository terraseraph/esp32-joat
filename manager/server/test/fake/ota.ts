/**
 * Fake device: OTA image helpers. An ESP32 app image is `esp_image_header_t` (24 bytes, first byte 0xE9), a first
 * segment header (8 bytes), then the `esp_app_desc_t` at file offset 32:
 *   +0 magic u32 LE 0xABCD5432, +16 version[32], +48 project_name[32], +80 time[16], +96 date[16], +112 idf_ver[32].
 */
import { DEFAULT_COMPILE_DATE, DEFAULT_COMPILE_TIME, FAKE_IDF, FAKE_PROJECT, type FakeSlot } from "./state";

export const IMAGE_MAGIC_BYTE = 0xe9;
export const APP_DESC_OFFSET = 32;
export const APP_DESC_MAGIC = 0xabcd5432;
const APP_DESC_SIZE = 256;

export interface FakeImageOptions {
  version?: string;
  project?: string;
  /** `__DATE__` format, e.g. `Nov 10 2026` (max 15 chars). */
  date?: string;
  /** `__TIME__` format, e.g. `09:12:44` (max 15 chars). */
  time?: string;
  idf?: string;
  /** Total image size in bytes (default 4096, minimum 288). */
  size?: number;
  /** Overwrite the first byte (default 0xE9) to build a bad-magic image. */
  firstByte?: number;
  /** Overwrite the app descriptor magic (default 0xABCD5432). */
  descMagic?: number;
}

function putString(buf: Buffer, offset: number, len: number, s: string): void {
  const b = Buffer.from(s, "utf8");
  b.copy(buf, offset, 0, Math.min(b.length, len - 1)); // keep a NUL terminator
}

/** Build a valid (or deliberately broken) app image for the fake device's `POST /ota`. */
export function makeFakeImage(o: FakeImageOptions = {}): Buffer {
  const size = o.size ?? 4096;
  if (size < APP_DESC_OFFSET + APP_DESC_SIZE) throw new Error(`image size must be at least ${APP_DESC_OFFSET + APP_DESC_SIZE}`);
  const buf = Buffer.alloc(size);
  for (let i = APP_DESC_OFFSET + APP_DESC_SIZE; i < size; i++) buf[i] = (i * 31) & 0xff; // deterministic filler
  buf[0] = o.firstByte ?? IMAGE_MAGIC_BYTE;
  buf[1] = 1; // segment count
  buf.writeUInt32LE(0x3f400020, 24); // segment load address
  buf.writeUInt32LE(size - APP_DESC_OFFSET, 28); // segment data length
  buf.writeUInt32LE(o.descMagic ?? APP_DESC_MAGIC, APP_DESC_OFFSET);
  putString(buf, APP_DESC_OFFSET + 16, 32, o.version ?? "abc1234");
  putString(buf, APP_DESC_OFFSET + 48, 32, o.project ?? FAKE_PROJECT);
  putString(buf, APP_DESC_OFFSET + 80, 16, o.time ?? DEFAULT_COMPILE_TIME);
  putString(buf, APP_DESC_OFFSET + 96, 16, o.date ?? DEFAULT_COMPILE_DATE);
  putString(buf, APP_DESC_OFFSET + 112, 32, o.idf ?? FAKE_IDF);
  return buf;
}

export type ParsedImage =
  | { ok: true; slot: FakeSlot }
  | { ok: false; error: string; incoming_version?: string; incoming_project?: string };

function readString(buf: Buffer, offset: number, len: number): string {
  const slice = buf.subarray(offset, offset + len);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul < 0 ? len : nul).toString("utf8");
}

/** The checks the firmware makes on an uploaded image (`ota_manager.cpp` finish step). Error strings are invented. */
export function parseFakeImage(buf: Buffer): ParsedImage {
  if (buf.length < APP_DESC_OFFSET + APP_DESC_SIZE) return { ok: false, error: "image too small" };
  if (buf[0] !== IMAGE_MAGIC_BYTE) return { ok: false, error: "bad image magic (first byte must be 0xE9)" };
  if (buf.readUInt32LE(APP_DESC_OFFSET) !== APP_DESC_MAGIC) return { ok: false, error: "bad app descriptor magic" };
  const version = readString(buf, APP_DESC_OFFSET + 16, 32);
  const project = readString(buf, APP_DESC_OFFSET + 48, 32);
  if (project !== FAKE_PROJECT) return { ok: false, error: `wrong project: ${project}`, incoming_version: version, incoming_project: project };
  return {
    ok: true,
    slot: {
      app_version: version,
      project,
      compile_time: readString(buf, APP_DESC_OFFSET + 80, 16),
      compile_date: readString(buf, APP_DESC_OFFSET + 96, 16),
      idf: readString(buf, APP_DESC_OFFSET + 112, 32),
    },
  };
}
