import { OEM_UPPER_HALF } from "./codepages";

/**
 * Turning the bytes a Windows console program printed into text. `netsh` writes in the console's OEM code page (850 on a
 * German PC, 437 in the US, 866 in Russia ...), so reading it as UTF-8 garbles every non-ASCII SSID. We ask for UTF-8 where
 * we safely can (see `buildUtf8Command` in netsh.ts) and decode whatever comes back robustly: valid UTF-8 is UTF-8, anything
 * else is the OEM code page, and when that is unknown or unsupported Latin-1.
 */

const utf8Strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

/** The bytes as UTF-8 text, or `null` when they are not valid UTF-8. A BOM is dropped. */
export function tryDecodeUtf8(bytes: Uint8Array): string | null {
  try {
    const text = utf8Strict.decode(bytes);
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch {
    return null;
  }
}

/** `TextDecoder` labels for the code pages it supports (the others come from `OEM_UPPER_HALF`). */
const TEXT_DECODER_LABELS: Readonly<Record<number, string>> = {
  866: "ibm866",
  874: "windows-874",
  932: "shift_jis",
  936: "gbk",
  949: "euc-kr",
  950: "big5",
  1250: "windows-1250",
  1251: "windows-1251",
  1252: "windows-1252",
  1253: "windows-1253",
  1254: "windows-1254",
  1255: "windows-1255",
  1256: "windows-1256",
  1257: "windows-1257",
  1258: "windows-1258",
  10000: "macintosh",
  20866: "koi8-r",
  21866: "koi8-u",
  28591: "iso-8859-1",
  28592: "iso-8859-2",
  28595: "iso-8859-5",
  28597: "iso-8859-7",
  28605: "iso-8859-15",
};

function latin1(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
}

/** True when a decoder for this code page exists here (otherwise `decodeWithCodePage` falls back to Latin-1). */
export function isSupportedCodePage(codePage: number): boolean {
  return codePage in OEM_UPPER_HALF || codePage in TEXT_DECODER_LABELS || codePage === 65001;
}

/** Decode bytes in the given Windows code page; an unknown one (or `null`) is read as Latin-1. Never throws. */
export function decodeWithCodePage(bytes: Uint8Array, codePage: number | null): string {
  if (codePage === null) return latin1(bytes);
  const upper = OEM_UPPER_HALF[codePage];
  if (upper !== undefined) {
    let out = "";
    for (const b of bytes) out += b < 0x80 ? String.fromCharCode(b) : (upper[b - 0x80] ?? "�");
    return out;
  }
  if (codePage === 65001) return new TextDecoder("utf-8").decode(bytes);
  const label = TEXT_DECODER_LABELS[codePage];
  if (label !== undefined) {
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      /* this Node was built without that table */
    }
  }
  return latin1(bytes);
}

/** Valid UTF-8 (including plain ASCII) decodes as UTF-8; anything else with `codePage` (the console's OEM code page, if known). */
export function decodeConsoleBytes(bytes: Uint8Array, codePage: number | null): string {
  return tryDecodeUtf8(bytes) ?? decodeWithCodePage(bytes, codePage);
}

/**
 * The OEM code page from the output of `reg query HKLM\SYSTEM\CurrentControlSet\Control\Nls\CodePage /v OEMCP`
 * (`    OEMCP    REG_SZ    850`) or of `chcp` (`Active code page: 850`, localised text, the number is last). `null` if neither.
 */
export function parseOemCodePage(text: string): number | null {
  const reg = /OEMCP\s+REG_SZ\s+(\d{3,5})/i.exec(text);
  const n = reg ? reg[1] : /(\d{3,5})\s*\.?\s*$/.exec(text.trim())?.[1];
  const cp = n === undefined ? NaN : Number(n);
  return Number.isInteger(cp) && cp > 0 ? cp : null;
}
