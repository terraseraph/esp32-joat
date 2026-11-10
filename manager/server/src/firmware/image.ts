import { createHash } from "node:crypto";

/**
 * Reads the header of an ESP32 application image (the `.bin` a device accepts at `POST /api/v1/ota`).
 *
 *  - byte 0 is the magic `0xE9`; the extended header holds the chip id at offset 12 (u16 LE, 0 = ESP32)
 *  - the first segment starts at offset 24 (8 byte segment header), so `esp_app_desc_t` is at offset 32:
 *    +0 magic u32 LE 0xABCD5432, +16 version[32], +48 project_name[32], +80 time[16], +96 date[16], +112 idf_ver[32]
 */

export const IMAGE_MAGIC_BYTE = 0xe9;
export const APP_DESC_OFFSET = 32;
export const APP_DESC_MAGIC = 0xabcd5432;
export const APP_DESC_SIZE = 256;
export const CHIP_ID_OFFSET = 12;
export const CHIP_ID_ESP32 = 0;
export const EXPECTED_PROJECT = "de_esp32_runtime";
export const MIN_IMAGE_BYTES = APP_DESC_OFFSET + APP_DESC_SIZE;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export interface ParsedImage {
  version: string;
  project: string;
  date: string;
  time: string;
  idfVer: string;
  chip: "esp32";
  size: number;
  /** SHA-256 hex of the whole file. */
  sha256: string;
}

/** The reason is plain words for a person (the API answers it as `422 invalid_image`). */
export class ImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageError";
  }
}

function readString(buf: Buffer, offset: number, len: number): string {
  const slice = buf.subarray(offset, offset + len);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul < 0 ? len : nul).toString("utf8");
}

/** Check the header of a whole file; throws `ImageError` with the reason. */
export function parseImage(buf: Buffer): ParsedImage {
  if (buf.length < MIN_IMAGE_BYTES) {
    throw new ImageError(`This file is only ${buf.length} bytes, too small to be a firmware image (at least ${MIN_IMAGE_BYTES}).`);
  }
  if (buf.length > MAX_IMAGE_BYTES) {
    throw new ImageError(`This file is ${(buf.length / 1048576).toFixed(1)} MB; a firmware image is at most ${MAX_IMAGE_BYTES / 1048576} MB.`);
  }
  if (buf[0] !== IMAGE_MAGIC_BYTE) {
    throw new ImageError("This is not an ESP32 firmware image (it does not start with the 0xE9 marker). Use the de_esp32_runtime.bin file, not the bootloader or a merged flash dump.");
  }
  const chip = buf.readUInt16LE(CHIP_ID_OFFSET);
  if (chip !== CHIP_ID_ESP32) {
    throw new ImageError("This image is built for a different chip than the classic ESP32.");
  }
  if (buf.readUInt32LE(APP_DESC_OFFSET) !== APP_DESC_MAGIC) {
    throw new ImageError("This file has no readable application header, so its version cannot be checked. It is probably not a de_esp32 firmware image.");
  }
  const project = readString(buf, APP_DESC_OFFSET + 48, 32);
  if (project !== EXPECTED_PROJECT) {
    throw new ImageError(`This image belongs to the project "${project || "unknown"}", not ${EXPECTED_PROJECT}.`);
  }
  const version = readString(buf, APP_DESC_OFFSET + 16, 32);
  if (!version) throw new ImageError("This image has no version in its header.");
  return {
    version,
    project,
    time: readString(buf, APP_DESC_OFFSET + 80, 16),
    date: readString(buf, APP_DESC_OFFSET + 96, 16),
    idfVer: readString(buf, APP_DESC_OFFSET + 112, 32),
    chip: "esp32",
    size: buf.length,
    sha256: createHash("sha256").update(buf).digest("hex"),
  };
}
