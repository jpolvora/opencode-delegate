import fs from "node:fs"
import path from "node:path"

/**
 * Minimal .env loader: KEY=VALUE, optional `export`, single/double quotes, `#` comments.
 * Never overrides an existing process environment value.
 */
export function loadEnvFile(file) {
  if (!file) return { file: null, loaded: false, keys: [] }
  const resolved = path.resolve(file)
  if (!fs.existsSync(resolved)) {
    return { file: resolved, loaded: false, keys: [] }
  }

  const keys = []
  const text = fs.readFileSync(resolved, "utf8")
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    if (line.startsWith("export ")) line = line.slice(7).trim()
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match) continue
    const key = match[1]
    let value = match[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    } else {
      const hash = value.indexOf(" #")
      if (hash >= 0) value = value.slice(0, hash).trim()
    }
    keys.push(key)
    if (process.env[key] === undefined) process.env[key] = value
  }

  return { file: resolved, loaded: true, keys }
}

export function boolFromEnv(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback
  if (typeof value === "boolean") return value
  const text = String(value).trim().toLowerCase()
  if (["1", "true", "yes", "on"].includes(text)) return true
  if (["0", "false", "no", "off"].includes(text)) return false
  return fallback
}

export function numberFromEnv(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}
