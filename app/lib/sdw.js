import { execFileSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { toPosix } from "./instructions.js"

const TASK_STATUSES = ["success", "partial", "failed", "blocked"]
const TEST_STATUSES = ["passed", "failed", "skipped"]
const VERDICT_VALUES = ["verified", "failed"]

function isExcludedPath(rel) {
  const norm = toPosix(rel).replace(/^\.\//, "")
  return (
    !norm ||
    norm === ".git" ||
    norm.startsWith(".git/") ||
    norm === ".sdw/state" ||
    norm.startsWith(".sdw/state/") ||
    norm === ".sdw/worktrees" ||
    norm.startsWith(".sdw/worktrees/") ||
    norm === ".sdw/sandbox" ||
    norm.startsWith(".sdw/sandbox/") ||
    norm === ".hermes" ||
    norm.startsWith(".hermes/")
  )
}

function hashFileSync(absPath) {
  try {
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) return null
    return crypto.createHash("sha256").update(fs.readFileSync(absPath)).digest("hex")
  } catch {
    return null
  }
}

function listModifiedPaths(root) {
  try {
    const statusOut = execFileSync("git", ["status", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
    const paths = new Set()
    for (const raw of statusOut.split(/\r?\n/)) {
      const trimmed = raw.trim()
      if (!trimmed) continue
      const body = trimmed.replace(/^[A-Z?!]{1,2}\s+/, "").trim()
      const target = body.includes(" -> ") ? body.split(" -> ").pop().trim() : body
      const unquoted = target.replace(/^"(.*)"$/, "$1")
      const norm = toPosix(unquoted).replace(/^\.\//, "")
      if (!isExcludedPath(norm)) paths.add(norm)
    }
    try {
      const diffOut = execFileSync("git", ["diff", "--name-only", "HEAD"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
      for (const raw of diffOut.split(/\r?\n/)) {
        const norm = toPosix(raw.trim()).replace(/^\.\//, "")
        if (!isExcludedPath(norm)) paths.add(norm)
      }
    } catch {
      // repository may not have a HEAD commit yet
    }
    return [...paths].sort()
  } catch {
    return []
  }
}

export function captureBaseline(root) {
  const dirty = listModifiedPaths(root)
  const hashes = {}
  for (const rel of dirty) {
    const h = hashFileSync(path.resolve(root, rel))
    if (h) hashes[rel] = h
  }
  return { dirty, hashes }
}

export function detectFilesChanged(root, baseline) {
  const current = listModifiedPaths(root)
  const baselineDirty = new Set(Array.isArray(baseline?.dirty) ? baseline.dirty : [])
  const baselineHashes = baseline?.hashes || {}
  const changed = []
  for (const rel of current) {
    if (!baselineDirty.has(rel)) {
      changed.push(rel)
      continue
    }
    const prior = baselineHashes[rel]
    const now = hashFileSync(path.resolve(root, rel))
    if (!prior || now !== prior) {
      changed.push(rel)
    }
  }
  return changed.sort()
}

export function buildPromptText({ instructions, sdw }) {
  const base = instructions.text
  if (!sdw) return base

  if (sdw.evidence) {
    return (
      `${base}\n\n` +
      `## OpenCode Delegate Worker Contract (sdw-run)\n` +
      `- Write the task evidence JSON to \`${toPosix(sdw.evidence.path)}\` before finishing.\n` +
      `- Every entry in \`tests\` must be an object \`{"name": "<non-empty>", "status": "passed" | "failed" | "skipped", "command": "<optional>"}\` (never \`{command, result}\`).\n` +
      `- Do not execute \`sdw_run.cjs task finish\` or \`git commit\`/\`push\`/\`tag\`/\`branch\`/\`checkout\`/\`worktree\`; write the evidence file and stop so the orchestrator can verify and checkpoint.`
    )
  }

  if (sdw.verdict) {
    return (
      `${base}\n\n` +
      `## OpenCode Delegate Judge Contract (sdw-run)\n` +
      `- Write the verdict JSON to \`${toPosix(sdw.verdict.path)}\` or return the raw JSON object as your final response.`
    )
  }

  return base
}

function extractJsonCandidates(text) {
  if (!text || typeof text !== "string") return []
  const candidates = []
  const fenced = [...text.matchAll(/```(?:json)?\s*\r?\n([\s\S]*?)```/gi)]
  for (const match of fenced.reverse()) {
    const body = match[1].trim()
    try {
      const parsed = JSON.parse(body)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        candidates.push(parsed)
      }
    } catch {
      // ignore non-json block
    }
  }
  const trimmed = text.trim()
  const firstBrace = trimmed.indexOf("{")
  const lastBrace = trimmed.lastIndexOf("}")
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      const parsed = JSON.parse(trimmed.slice(firstBrace, lastBrace + 1))
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        candidates.push(parsed)
      }
    } catch {
      // ignore
    }
  }
  return candidates
}

function normalizeTestStatus(value) {
  if (typeof value === "boolean") return value ? "passed" : "failed"
  if (typeof value === "number") return value === 0 ? "passed" : "failed"
  const text = String(value ?? "").trim().toLowerCase()
  if (["passed", "pass", "ok", "success", "succeeded", "0", "true"].includes(text)) return "passed"
  if (["failed", "fail", "error", "false"].includes(text)) return "failed"
  if (["skipped", "skip", "ignored", "todo"].includes(text)) return "skipped"
  return text
}

function normalizeRelPath(rawPath, root, targetRoot) {
  const trimmed = String(rawPath ?? "").trim()
  if (!trimmed) return ""
  const posix = toPosix(trimmed)
  if (path.isAbsolute(trimmed)) {
    for (const base of [root, targetRoot].filter(Boolean)) {
      const rel = toPosix(path.relative(base, trimmed))
      if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
        return rel.replace(/^\.\//, "")
      }
    }
    return posix
  }
  return posix.replace(/^\.\//, "")
}

function normalizeEvidenceObject(raw, { sdw, root, targetRoot }) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { data: raw, repaired: false }
  }
  const out = { ...raw }
  let repaired = false

  if ((!out.taskId || typeof out.taskId !== "string") && sdw?.taskId) {
    out.taskId = sdw.taskId
    repaired = true
  }

  if (typeof out.status === "string") {
    const normStatus = out.status.trim().toLowerCase()
    if (normStatus === "succeeded" || normStatus === "completed" || normStatus === "ok") {
      out.status = "success"
      repaired = true
    } else if (normStatus !== out.status) {
      out.status = normStatus
      repaired = true
    }
  }

  if ((!Array.isArray(out.acIds) || out.acIds.length === 0) && Array.isArray(sdw?.acIds) && sdw.acIds.length > 0 && out.status === "success") {
    out.acIds = [...sdw.acIds]
    repaired = true
  }

  if (Array.isArray(out.filesChanged)) {
    const normFiles = out.filesChanged.map((item) => {
      if (typeof item !== "string") return item
      const norm = normalizeRelPath(item, root, targetRoot)
      if (norm !== item) repaired = true
      return norm
    })
    out.filesChanged = normFiles
  }

  if (Array.isArray(out.tests)) {
    out.tests = out.tests.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry
      const item = { ...entry }
      if ((!item.name || typeof item.name !== "string" || !item.name.trim()) && typeof item.command === "string" && item.command.trim()) {
        item.name = item.command.trim()
        repaired = true
      }
      const rawStatus = item.status ?? item.result ?? item.outcome
      const normStatus = normalizeTestStatus(rawStatus)
      if (TEST_STATUSES.includes(normStatus) && item.status !== normStatus) {
        item.status = normStatus
        repaired = true
      }
      if ("result" in item) {
        delete item.result
        repaired = true
      }
      if ("outcome" in item) {
        delete item.outcome
        repaired = true
      }
      return item
    })
  }

  return { data: out, repaired }
}

export function validateEvidenceObject(evidence, { expectedTaskId, allowEmptyFilesChanged = false } = {}) {
  const errors = []
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    return { valid: false, errors: ["Evidence must be a JSON object."] }
  }

  if (!evidence.taskId || typeof evidence.taskId !== "string" || !evidence.taskId.trim()) {
    errors.push('Missing or invalid "taskId": must be a non-empty string.')
  } else if (expectedTaskId && evidence.taskId !== expectedTaskId) {
    errors.push(`"taskId" mismatch: expected "${expectedTaskId}", got "${evidence.taskId}".`)
  }

  if (!evidence.status || !TASK_STATUSES.includes(String(evidence.status))) {
    errors.push(`Invalid "status" "${evidence.status ?? ""}": must be one of ${TASK_STATUSES.join(", ")}.`)
  }

  if (!Array.isArray(evidence.acIds) || evidence.acIds.length === 0) {
    errors.push('"acIds" must be a non-empty array of acceptance criterion identifiers.')
  } else {
    for (const acId of evidence.acIds) {
      if (typeof acId !== "string" || !acId.trim()) {
        errors.push('Invalid AC ID in "acIds": must be a non-empty string.')
      }
    }
  }

  const isRefine = allowEmptyFilesChanged || evidence.taskId === "task-refine"
  if (!Array.isArray(evidence.filesChanged) || (evidence.filesChanged.length === 0 && !isRefine)) {
    errors.push(
      isRefine
        ? '"filesChanged" must be an array of project-relative file paths.'
        : '"filesChanged" must be a non-empty array of project-relative file paths.',
    )
  } else {
    for (const relPath of evidence.filesChanged) {
      if (typeof relPath !== "string" || !relPath.trim()) {
        errors.push('Invalid file path in "filesChanged": must be a non-empty string.')
        continue
      }
      const norm = toPosix(relPath.trim())
      if (path.isAbsolute(norm) || /^[a-zA-Z]:/.test(norm) || norm.startsWith("/")) {
        errors.push(`File path "${relPath}" must be relative to the project root, not absolute.`)
        continue
      }
      const segments = norm.split("/")
      if (segments.includes("..")) {
        errors.push(`File path "${relPath}" must not contain path traversal ("..").`)
        continue
      }
      if (segments[0] === ".git") {
        errors.push(`File path "${relPath}" cannot reference files inside ".git/".`)
      }
    }
  }

  if ("tests" in evidence && evidence.tests !== undefined && evidence.tests !== null) {
    if (!Array.isArray(evidence.tests)) {
      errors.push('"tests" must be an array when provided.')
    } else {
      evidence.tests.forEach((t, idx) => {
        if (!t || typeof t !== "object" || Array.isArray(t)) {
          errors.push(`Test entry at index ${idx} must be an object.`)
          return
        }
        if (!t.name || typeof t.name !== "string" || !t.name.trim()) {
          errors.push(`Test entry at index ${idx} must contain a non-empty "name".`)
        }
        if (!t.status || typeof t.status !== "string" || !TEST_STATUSES.includes(t.status)) {
          errors.push(
            `Test entry at index ${idx} has invalid status "${t.status}": must be one of ${TEST_STATUSES.join(", ")}.`,
          )
        }
        if ("command" in t && t.command !== null && t.command !== undefined && typeof t.command !== "string") {
          errors.push(`Test entry at index ${idx} "command" must be a string if provided.`)
        }
      })
    }
  }

  if (!evidence.summary || typeof evidence.summary !== "string" || !evidence.summary.trim()) {
    errors.push('"summary" must be a non-empty string.')
  }

  return { valid: errors.length === 0, errors }
}

export async function finalizeEvidence({ evidence, root, targetRoot, sdw, text }) {
  if (!evidence?.path) return null

  let exists = fs.existsSync(evidence.path)
  let raw = null
  let repaired = false
  let parseError = null

  if (exists) {
    try {
      raw = JSON.parse(await fsp.readFile(evidence.path, "utf8"))
    } catch (error) {
      parseError = `Failed to parse evidence JSON: ${error.message}`
    }
  } else {
    const candidates = extractJsonCandidates(text)
    const match = candidates.find(
      (item) =>
        item &&
        typeof item === "object" &&
        ("filesChanged" in item || "acIds" in item || "taskId" in item) &&
        "status" in item,
    )
    if (match) {
      raw = match
      repaired = true
    }
  }

  if (!raw) {
    return {
      path: evidence.path,
      relative: evidence.relative,
      exists,
      valid: false,
      repaired: false,
      status: null,
      errors: [parseError || `Evidence file does not exist: "${evidence.relative}".`],
      data: null,
    }
  }

  const normalized = normalizeEvidenceObject(raw, { sdw, root, targetRoot })
  const data = normalized.data
  repaired = repaired || normalized.repaired

  const validation = validateEvidenceObject(data, {
    expectedTaskId: sdw?.taskId || undefined,
  })

  if ((exists && repaired) || (!exists && data.status === "success")) {
    await writeJsonAtomic(evidence.path, data)
    exists = true
  }

  return {
    path: evidence.path,
    relative: evidence.relative,
    exists,
    valid: validation.valid,
    repaired,
    status: typeof data.status === "string" ? data.status : null,
    errors: validation.errors,
    data,
  }
}

export function validateVerdictObject(verdict) {
  const errors = []
  if (!verdict || typeof verdict !== "object" || Array.isArray(verdict)) {
    return {
      valid: false,
      errors: ['Verdict must be a JSON object of the shape {"score": <0-10>, "verdicts": [...]}.'],
    }
  }

  if (!Number.isInteger(verdict.score) || verdict.score < 0 || verdict.score > 10) {
    errors.push(`Verdict "score" must be an integer between 0 and 10 (received: ${JSON.stringify(verdict.score)}).`)
  }

  if (!Array.isArray(verdict.verdicts) || verdict.verdicts.length === 0) {
    errors.push('Verdict "verdicts" must be a non-empty array.')
  } else {
    const seen = new Set()
    verdict.verdicts.forEach((entry, index) => {
      const label = `verdicts[${index}]`
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        errors.push(`${label} must be an object.`)
        return
      }
      const id = typeof entry.id === "string" ? entry.id.trim() : ""
      if (!id) {
        errors.push(`${label}.id must be a non-empty acceptance criterion id.`)
      } else if (seen.has(id)) {
        errors.push(`${label}.id "${id}" appears more than once.`)
      } else {
        seen.add(id)
      }
      const v = typeof entry.verdict === "string" ? entry.verdict.trim().toLowerCase() : ""
      if (!VERDICT_VALUES.includes(v)) {
        errors.push(`${label}.verdict must be one of: ${VERDICT_VALUES.join(", ")} (received: ${JSON.stringify(entry.verdict)}).`)
      }
      const ev = typeof entry.evidence === "string" ? entry.evidence.trim() : ""
      if (!ev) {
        errors.push(`${label}.evidence must be a non-empty string citing the diff or the missing behaviour.`)
      }
    })
  }

  if (verdict.notes !== undefined && verdict.notes !== null && typeof verdict.notes !== "string") {
    errors.push('Verdict "notes" must be a string when present.')
  }

  return { valid: errors.length === 0, errors }
}

export async function finalizeVerdict({ verdict, text }) {
  if (!verdict?.path) return null

  let exists = fs.existsSync(verdict.path)
  let raw = null
  let extracted = false
  let parseError = null

  if (exists) {
    try {
      raw = JSON.parse(await fsp.readFile(verdict.path, "utf8"))
    } catch (error) {
      parseError = `Failed to parse verdict JSON: ${error.message}`
    }
  } else {
    const candidates = extractJsonCandidates(text)
    const match = candidates.find(
      (item) => item && typeof item === "object" && Array.isArray(item.verdicts),
    )
    if (match) {
      raw = match
      extracted = true
    }
  }

  if (!raw) {
    return {
      path: verdict.path,
      relative: verdict.relative,
      exists,
      valid: false,
      extracted: false,
      score: null,
      errors: [parseError || `Verdict file was not written and no JSON verdict was found in output: "${verdict.relative}".`],
      data: null,
    }
  }

  const data = { ...raw }
  let repaired = false
  if (Array.isArray(data.verdicts)) {
    data.verdicts = data.verdicts.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry
      const normVerdict = typeof entry.verdict === "string" ? entry.verdict.trim().toLowerCase() : entry.verdict
      if (normVerdict !== entry.verdict) repaired = true
      return {
        ...entry,
        ...(typeof entry.id === "string" ? { id: entry.id.trim() } : {}),
        verdict: normVerdict,
        ...(typeof entry.evidence === "string" ? { evidence: entry.evidence.trim() } : {}),
      }
    })
    if (!Number.isInteger(data.score) && data.verdicts.length > 0) {
      const verified = data.verdicts.filter((entry) => entry?.verdict === "verified").length
      data.score = Math.round((verified / data.verdicts.length) * 10)
      repaired = true
    }
  }

  const validation = validateVerdictObject(data)
  if ((extracted || repaired) && validation.valid) {
    await writeJsonAtomic(verdict.path, data)
    exists = true
  }

  return {
    path: verdict.path,
    relative: verdict.relative,
    exists,
    valid: validation.valid,
    extracted,
    score: Number.isInteger(data.score) ? data.score : null,
    errors: validation.errors,
    data,
  }
}

export function summarizeAssistantText(text) {
  if (!text || typeof text !== "string") return ""
  const clean = text
    .replace(/```[\s\S]*?```/g, "")
    .trim()
  const firstParagraph = (clean.split(/\r?\n\s*\r?\n/)[0] || clean)
    .replace(/\s+/g, " ")
    .trim()
  if (!firstParagraph) return ""
  return firstParagraph.length <= 240 ? firstParagraph : `${firstParagraph.slice(0, 240)}…`
}

async function writeJsonAtomic(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8")
  await fsp.rename(tmp, file)
}
