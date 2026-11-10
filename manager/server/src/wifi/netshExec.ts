import { execFile } from "node:child_process";
import { decodeConsoleBytes, parseOemCodePage, tryDecodeUtf8 } from "./decode";

/**
 * Running `netsh` and reading what it prints. Windows writes console programs' output in the OEM code page, so the bytes
 * are decoded robustly (see `decode.ts`) and, where it is safe, netsh is asked for UTF-8 in the first place. Everything is
 * injectable (`RawExecFn`) so tests never start a process.
 */

export interface ExecResult {
  stdout: string;
  stderr: string;
  /** Process exit code; -1 when the program could not be started. */
  code: number;
}

export type ExecFn = (file: string, args: string[], opts?: { timeoutMs?: number }) => Promise<ExecResult>;

export interface RawExecResult {
  stdout: Buffer;
  stderr: Buffer;
  /** Process exit code; -1 when the program could not be started. */
  code: number;
}

/** Runs a program and hands back the raw bytes (never rejects). `verbatim`: `args` already are a Windows command line, pass them untouched. */
export type RawExecFn = (file: string, args: string[], opts?: { timeoutMs?: number; verbatim?: boolean }) => Promise<RawExecResult>;

/** Real raw exec: no window, never rejects. */
export const execNativeRaw: RawExecFn = (file, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { windowsHide: true, windowsVerbatimArguments: opts.verbatim === true, timeout: opts.timeoutMs ?? 15_000, encoding: "buffer", maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err === null ? 0 : typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : -1;
        resolve({ stdout, stderr: code === -1 && err && stderr.length === 0 ? Buffer.from(err.message, "utf8") : stderr, code });
      },
    );
  });

/** Arguments that mean nothing to cmd.exe: no quotes, `& | < > ^ %` or `!`. Letters and digits of any script are fine. */
const CMD_SAFE_ARG = /^[\p{L}\p{N}=._ -]+$/u;

/**
 * `cmd.exe /d /s /c "chcp 65001>nul & netsh ..."` makes netsh print UTF-8, so a non-ASCII SSID survives whatever the PC's OEM
 * code page is. Only for arguments cmd.exe cannot misread (an SSID with `&` or `%` must never reach a shell); `null`
 * otherwise, and then netsh runs directly and its OEM output is decoded instead.
 */
export function buildUtf8Command(file: string, args: string[]): { file: string; args: string[] } | null {
  if (file !== "netsh" || args.length === 0 || !args.every((a) => CMD_SAFE_ARG.test(a))) return null;
  const quoted = args.map((a) => (a.includes(" ") ? `"${a}"` : a));
  return { file: "cmd.exe", args: ["/d", "/s", "/c", `"chcp 65001>nul & netsh ${quoted.join(" ")}"`] };
}

/**
 * The console's OEM code page without asking netsh: `reg query` of the OEMCP value, else `chcp` (both read-only). The first
 * answer is kept for the life of the process; a lookup that failed is retried a few times.
 */
export function createOemCodePageLookup(raw: RawExecFn): () => Promise<number | null> {
  let cached: number | null = null;
  let failures = 0;
  const ascii = (b: Buffer): string => b.toString("latin1");
  return async () => {
    if (cached !== null || failures >= 3) return cached;
    const reg = await raw("reg", ["query", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage", "/v", "OEMCP"], { timeoutMs: 5000 });
    let cp = reg.code === 0 ? parseOemCodePage(ascii(reg.stdout)) : null;
    if (cp === null) {
      const chcp = await raw("cmd.exe", ["/d", "/c", "chcp"], { timeoutMs: 5000 });
      cp = chcp.code === 0 ? parseOemCodePage(ascii(chcp.stdout)) : null;
    }
    if (cp === null) failures++;
    else cached = cp;
    return cp;
  };
}

/**
 * The exec used for netsh: UTF-8 output when the arguments allow it (`buildUtf8Command`) and, whatever comes back, a decode
 * that copes with the OEM code page: valid UTF-8 as UTF-8, else the OEM code page, else Latin-1.
 */
export function createNetshExec(raw: RawExecFn = execNativeRaw, lookup: () => Promise<number | null> = createOemCodePageLookup(raw)): ExecFn {
  return async (file, args, opts = {}) => {
    const wrapped = buildUtf8Command(file, args);
    let res = wrapped ? await raw(wrapped.file, wrapped.args, { ...opts, verbatim: true }) : await raw(file, args, opts);
    if (wrapped && res.code === -1) res = await raw(file, args, opts); // cmd.exe itself could not start: run netsh as it is
    const clean = tryDecodeUtf8(res.stdout) !== null && tryDecodeUtf8(res.stderr) !== null;
    const cp = clean ? null : await lookup();
    return { stdout: decodeConsoleBytes(res.stdout, cp), stderr: decodeConsoleBytes(res.stderr, cp), code: res.code };
  };
}

/** Real `exec` for netsh. */
export const execNative: ExecFn = createNetshExec();
