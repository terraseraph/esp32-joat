import { execFile } from "node:child_process"
import { ROOT } from "./build.js"

function git(args: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd: ROOT, windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, output: (stdout + stderr).trim() || (err ? String(err.message) : "") })
    })
  })
}

export async function gitStatus() {
  const [branch, st, ahead] = await Promise.all([
    git(["rev-parse", "--abbrev-ref", "HEAD"]),
    git(["status", "--porcelain", "--untracked-files=all", "--", "designs", "lib"]),
    git(["rev-list", "--count", "@{u}..HEAD"]),
  ])
  const files = st.output
    .split("\n")
    .filter(Boolean)
    .map((l) => ({ status: l.slice(0, 2).trim(), path: l.slice(3) }))
  return { branch: branch.output, dirty: files.length > 0, files, ahead: ahead.ok ? Number(ahead.output) || 0 : 0 }
}

export async function gitCommit(message: string) {
  const add = await git(["add", "--", "designs", "lib"])
  if (!add.ok) return add
  return git(["commit", "-m", message, "--", "designs", "lib"])
}

export const gitPush = () => git(["push"])
