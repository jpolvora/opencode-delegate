#!/usr/bin/env node
import fs from "node:fs"
import { UsageError, parseArgs, usage } from "./lib/args.js"
import { normalizeSettings, readConfig, resolveConfigPath } from "./lib/config.js"
import { loadEnvFile } from "./lib/env.js"
import { pluginEnvPath } from "./lib/paths.js"

function version() {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"))
    return pkg.version || "0.0.0"
  } catch {
    return "0.0.0"
  }
}

async function main(argv) {
  let args
  try {
    args = parseArgs(argv)
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`opencode-delegate: ${error.message}\n\n${usage()}`)
      return 2
    }
    throw error
  }

  if (args.help) {
    process.stdout.write(usage())
    return 0
  }
  if (args.version) {
    process.stdout.write(`${version()}\n`)
    return 0
  }

  const envFile = args.envFile || process.env.OPENCODE_DELEGATE_ENV || pluginEnvPath()
  const loadedEnv = loadEnvFile(envFile)
  if (args.envFile && !loadedEnv.loaded) {
    process.stderr.write(`opencode-delegate: env file not found: ${loadedEnv.file}\n`)
    return 2
  }

  const configPath = resolveConfigPath({
    explicit: args.config || process.env.OPENCODE_DELEGATE_CONFIG,
    envConfig: process.env.OPENCODE_DELEGATE_CONFIG,
  })
  const { config } = readConfig(configPath)
  const settings = normalizeSettings({ args, config })
  settings.configFile = config.__file || configPath
  settings.root = args.root || process.env.OPENCODE_DELEGATE_ROOT || config.root || ""
  settings.instructions =
    args.instructions || process.env.OPENCODE_DELEGATE_INSTRUCTIONS || config.instructions || ""

  if (settings.printConfig) {
    const printable = {
      ...settings,
      headers: redactHeaders(settings.headers),
      config_file: settings.configFile,
      env_file: loadedEnv.loaded ? loadedEnv.file : null,
    }
    process.stdout.write(`${JSON.stringify(printable, null, 2)}\n`)
    return 0
  }

  if (!settings.root || !settings.instructions) {
    const missing = []
    if (!settings.root) missing.push("--root")
    if (!settings.instructions) missing.push("--instructions")
    process.stderr.write(
      `opencode-delegate: missing ${missing.join(" and ")}\n\n${usage()}`,
    )
    return 2
  }

  const { runTask } = await import("./lib/run.js")
  return runTask(settings)
}

function redactHeaders(headers) {
  if (!headers || typeof headers !== "object") return {}
  const out = {}
  for (const [key, value] of Object.entries(headers)) {
    out[key] = /authorization|token|key|secret|password|credential/i.test(key)
      ? "[redacted]"
      : value
  }
  return out
}

try {
  const code = await main(process.argv.slice(2))
  process.exitCode = code
} catch (error) {
  const message = error?.message || String(error)
  process.stderr.write(`opencode-delegate: ${message}\n`)
  if (process.env.OPENCODE_DELEGATE_DEBUG === "1" && error?.stack) {
    process.stderr.write(`${error.stack}\n`)
  }
  process.exitCode = 2
}
