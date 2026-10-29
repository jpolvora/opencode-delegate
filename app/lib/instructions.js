import crypto from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export async function resolveRoot(value) {
  if (!value) {
    throw new Error("missing --root (the harness/runtime directory)")
  }
  const resolved = path.resolve(expandHome(value))
  let real
  try {
    real = await fs.realpath(resolved)
  } catch {
    throw new Error(`root does not exist: ${resolved}`)
  }
  const stat = await fs.stat(real)
  if (!stat.isDirectory()) throw new Error(`root is not a directory: ${real}`)
  return { input: resolved, real }
}

export async function resolveInstructions({ root, value }) {
  if (!value) {
    throw new Error("missing --instructions (a file inside --root)")
  }

  if (value === "-") {
    const text = (await readStdin()).trimEnd()
    if (!text.trim()) throw new Error("stdin contained no instructions")
    return {
      input: "-",
      path: null,
      relative: "-",
      text,
      bytes: Buffer.byteLength(text),
      sha256: sha256(text),
    }
  }

  const expanded = expandHome(value)
  const candidate = path.isAbsolute(expanded) ? expanded : path.resolve(root.real, expanded)
  let real
  try {
    real = await fs.realpath(candidate)
  } catch {
    throw new Error(`instructions file does not exist: ${candidate}`)
  }

  if (!isInside(root.real, real)) {
    throw new Error(`instructions file escapes the root: ${real} is outside ${root.real}`)
  }

  const stat = await fs.stat(real)
  if (!stat.isFile()) throw new Error(`instructions path is not a file: ${real}`)

  const text = (await fs.readFile(real, "utf8")).trimEnd()
  if (!text.trim()) throw new Error(`instructions file is empty: ${real}`)

  return {
    input: value,
    path: real,
    relative: path.relative(root.real, real),
    text,
    bytes: Buffer.byteLength(text),
    sha256: sha256(text),
  }
}

export async function detectHarness(root) {
  const names = ["AGENTS.md", "opencode.json", "opencode.jsonc", ".opencode", "CLAUDE.md", "claude.md"]
  const found = []
  for (const name of names) {
    try {
      await fs.access(path.join(root, name))
      found.push(name)
    } catch {
      // absent
    }
  }
  return {
    root,
    files: found,
    has_agents_md: found.includes("AGENTS.md"),
    has_opencode_config: found.includes("opencode.json") || found.includes("opencode.jsonc"),
    has_opencode_dir: found.includes(".opencode"),
  }
}

export function isInside(root, target) {
  const relative = path.relative(root, target)
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  )
}

export function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex")
}

function expandHome(value) {
  const text = String(value)
  if (text === "~") return os.homedir()
  if (text.startsWith("~/")) return path.join(os.homedir(), text.slice(2))
  return text
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString("utf8")
}
