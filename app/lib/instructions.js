import crypto from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export async function resolveRoot(value, label = "root") {
  if (!value) {
    throw new Error("missing --root (the harness/runtime directory)")
  }
  const resolved = path.resolve(expandHome(value))
  let real
  try {
    real = await fs.realpath(resolved)
  } catch {
    throw new Error(`${label} does not exist: ${resolved}`)
  }
  const stat = await fs.stat(real)
  if (!stat.isDirectory()) throw new Error(`${label} is not a directory: ${real}`)
  return { input: resolved, real }
}

export async function resolveTargetRoot({ root, value }) {
  if (value) {
    return resolveRoot(value, "target root")
  }
  const normalized = toPosix(root.real)
  const marker = "/.sdw/worktrees/"
  const idx = normalized.indexOf(marker)
  if (idx > 0) {
    const inferred = root.real.slice(0, idx)
    try {
      const real = await fs.realpath(inferred)
      const stat = await fs.stat(real)
      if (stat.isDirectory()) return { input: inferred, real, inferred: true }
    } catch {
      // fall back to root
    }
  }
  return { input: root.input, real: root.real, inferred: false }
}

export async function resolveInstructions({ root, targetRoot, value }) {
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
  const outer = targetRoot?.real || root.real
  let candidate = path.isAbsolute(expanded) ? expanded : path.resolve(root.real, expanded)
  let real
  try {
    real = await fs.realpath(candidate)
  } catch {
    if (!path.isAbsolute(expanded) && outer !== root.real) {
      const fallback = path.resolve(outer, expanded)
      try {
        real = await fs.realpath(fallback)
        candidate = fallback
      } catch {
        throw new Error(`instructions file does not exist: ${candidate}`)
      }
    } else {
      throw new Error(`instructions file does not exist: ${candidate}`)
    }
  }

  const insideRoot = isInside(root.real, real)
  const insideOuter = outer !== root.real && isInside(outer, real)
  if (!insideRoot && !insideOuter) {
    throw new Error(`instructions file escapes the root: ${real} is outside ${root.real}`)
  }

  const stat = await fs.stat(real)
  if (!stat.isFile()) throw new Error(`instructions path is not a file: ${real}`)

  const text = (await fs.readFile(real, "utf8")).trimEnd()
  if (!text.trim()) throw new Error(`instructions file is empty: ${real}`)

  const baseRoot = insideRoot ? root.real : outer
  return {
    input: value,
    path: real,
    relative: toPosix(path.relative(baseRoot, real)),
    text,
    bytes: Buffer.byteLength(text),
    sha256: sha256(text),
  }
}

export async function resolveArtifactPath({ root, targetRoot, value, label = "artifact" }) {
  if (!value) return null
  const expanded = expandHome(value)
  const outer = targetRoot?.real || root.real
  let candidate
  if (path.isAbsolute(expanded)) {
    candidate = path.resolve(expanded)
  } else if (outer !== root.real && toPosix(expanded).startsWith(".sdw/state/")) {
    candidate = path.resolve(outer, expanded)
  } else {
    candidate = path.resolve(root.real, expanded)
  }

  const resolvedTarget = await resolveNonExistentRealpath(candidate)
  const insideRoot = isInside(root.real, resolvedTarget)
  const insideOuter = outer !== root.real && isInside(outer, resolvedTarget)
  if (!insideRoot && !insideOuter) {
    throw new Error(`${label} file escapes the root: ${resolvedTarget} is outside ${root.real}`)
  }

  const baseRoot = insideRoot ? root.real : outer
  return {
    input: value,
    path: resolvedTarget,
    relative: toPosix(path.relative(baseRoot, resolvedTarget)),
  }
}

export function inferSdwMetadata(instructions) {
  const out = {
    kind: null,
    taskId: "",
    specSlug: "",
    runId: "",
    evidenceFile: "",
    verdictFile: "",
    acIds: [],
  }
  if (!instructions) return out

  const filePath = instructions.path ? toPosix(instructions.path) : ""
  const parseTaskFilename = (suffix) => (suffix.startsWith("task-") ? suffix : `task-${suffix}`)

  const taskMatch = /(?:^|\/)\.sdw\/state\/([^/]+)\/([^/]+)\/task-([^/]+)\.prompt\.md$/.exec(filePath)
  if (taskMatch) {
    out.kind = "task"
    out.specSlug = taskMatch[1]
    out.runId = taskMatch[2]
    out.taskId = parseTaskFilename(taskMatch[3])
    out.evidenceFile = instructions.path.replace(/\.prompt\.md$/, ".evidence.json")
  } else if (instructions.path) {
    const baseMatch = /^task-(.+)\.prompt\.md$/.exec(path.basename(instructions.path))
    if (baseMatch) {
      out.kind = "task"
      out.taskId = parseTaskFilename(baseMatch[1])
      out.evidenceFile = instructions.path.replace(/\.prompt\.md$/, ".evidence.json")
    }
  }

  const judgeMatch = /(?:^|\/)\.sdw\/state\/([^/]+)\/([^/]+)\/step-5-judge\.prompt\.md$/.exec(filePath)
  if (judgeMatch) {
    out.kind = "judge"
    out.specSlug = judgeMatch[1]
    out.runId = judgeMatch[2]
    out.verdictFile = path.join(path.dirname(instructions.path), "step-5-judge.verdict.json")
  } else if (instructions.path && path.basename(instructions.path) === "step-5-judge.prompt.md") {
    out.kind = "judge"
    out.verdictFile = path.join(path.dirname(instructions.path), "step-5-judge.verdict.json")
  }

  const text = instructions.text || ""
  const taskIdHeader = /^-\s+\*\*Task ID:\*\*\s+(\S+)/m.exec(text)
  if (taskIdHeader) out.taskId = taskIdHeader[1].trim()
  const slugHeader = /^-\s+\*\*Specification Slug:\*\*\s+(\S+)/m.exec(text)
  if (slugHeader) out.specSlug = slugHeader[1].trim()
  const runIdHeader = /^-\s+\*\*Run ID:\*\*\s+(\S+)/m.exec(text)
  if (runIdHeader) out.runId = runIdHeader[1].trim()
  if (!out.evidenceFile) {
    const m = /^-\s+\*\*Evidence File Destination:\*\*\s+`([^`]+)`/m.exec(text)
    if (m) {
      out.kind = out.kind || "task"
      out.evidenceFile = m[1].trim()
    }
  }
  const acSection = /## Assigned Acceptance Criteria\r?\n([\s\S]*?)(?:\r?\n## |\s*$)/.exec(text)
  if (acSection) {
    const ids = [...acSection[1].matchAll(/^-\s+(AC[A-Za-z0-9_-]+)\s*:/gm)].map((m) => m[1])
    if (ids.length) out.acIds = ids
  }
  if (!out.kind && /^#\s+Conformance judge\s+[—-]\s+(\S+)/m.test(text)) {
    const m = /^#\s+Conformance judge\s+[—-]\s+(\S+)/m.exec(text)
    out.kind = "judge"
    if (m && !out.specSlug) out.specSlug = m[1].trim()
  }

  return out
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

export function toPosix(value) {
  return String(value || "").replace(/\\/g, "/")
}

async function resolveNonExistentRealpath(target) {
  const abs = path.resolve(target)
  const suffix = []
  let curr = abs
  while (true) {
    try {
      const real = await fs.realpath(curr)
      return suffix.length ? path.join(real, ...suffix.reverse()) : real
    } catch {
      const parent = path.dirname(curr)
      if (parent === curr) return abs
      suffix.push(path.basename(curr))
      curr = parent
    }
  }
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
