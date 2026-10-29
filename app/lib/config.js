import fs from "node:fs"
import path from "node:path"
import { expandHome, pluginConfigPath, pluginDataDir } from "./paths.js"

export const DEFAULTS = {
  server: {
    url: "",
    auto_start: false,
    headers: {},
  },
  provider: "",
  model: "",
  variant: "",
  models: {},
  agent: "build",
  auto_approve: false,
  permissions: [],
  timeout_seconds: 3600,
  heartbeat_seconds: 30,
  reasoning: true,
  run_dir: "",
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function deepMerge(base, extra) {
  if (!isPlainObject(extra)) return base
  const out = { ...base }
  for (const [key, value] of Object.entries(extra)) {
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key], value)
    } else {
      out[key] = value
    }
  }
  return out
}

export function readConfig(file) {
  if (!file || !fs.existsSync(file)) return { config: { ...DEFAULTS }, file: null, exists: false }
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"))
  } catch (error) {
    throw new Error(`cannot parse config ${file}: ${error.message}`)
  }
  if (!isPlainObject(parsed)) throw new Error(`config ${file} must contain a JSON object`)
  const resolved = path.resolve(file)
  return { config: { ...deepMerge(DEFAULTS, parsed), __file: resolved }, file: resolved, exists: true }
}

export function resolveConfigPath({ explicit, envConfig }) {
  if (explicit) {
    const resolved = path.resolve(expandHome(explicit))
    if (!fs.existsSync(resolved)) throw new Error(`config file not found: ${resolved}`)
    return resolved
  }
  if (envConfig) {
    const resolved = path.resolve(expandHome(envConfig))
    if (fs.existsSync(resolved)) return resolved
  }
  const dataConfig = path.join(pluginDataDir(), "config.json")
  if (fs.existsSync(dataConfig)) return dataConfig
  return pluginConfigPath()
}

export function normalizeSettings({ args, config, env = process.env }) {
  const server = isPlainObject(config.server) ? config.server : {}
  const models = isPlainObject(config.models) ? config.models : {}

  const modelSpec =
    args.model ??
    env.OPENCODE_DELEGATE_MODEL ??
    config.model ??
    models.default ??
    ""

  const providerHint =
    args.provider ??
    env.OPENCODE_DELEGATE_PROVIDER ??
    config.provider ??
    ""

  const variant =
    args.variant ??
    env.OPENCODE_DELEGATE_VARIANT ??
    config.variant ??
    ""

  const agent =
    args.agent ??
    env.OPENCODE_DELEGATE_AGENT ??
    config.agent ??
    ""

  const autoApprove =
    args.auto ||
    bool(env.OPENCODE_DELEGATE_AUTO_APPROVE, config.auto_approve) ||
    false

  const reasoning =
    args.noReasoning === true
      ? false
      : bool(env.OPENCODE_DELEGATE_REASONING, config.reasoning ?? true)

  const timeoutSeconds = number(
    args.timeout ?? env.OPENCODE_DELEGATE_TIMEOUT,
    number(config.timeout_seconds, 3600),
  )

  const heartbeatSeconds = Math.max(0, number(args.heartbeat, number(config.heartbeat_seconds, 30)))

  return {
    root: String(args.root ?? env.OPENCODE_DELEGATE_ROOT ?? config.root ?? "").trim(),
    instructions: String(
      args.instructions ?? env.OPENCODE_DELEGATE_INSTRUCTIONS ?? config.instructions ?? "",
    ).trim(),
    serverUrl: String(args.server ?? env.OPENCODE_SERVER_URL ?? server.url ?? "").trim(),
    autoStart: Boolean(args.autoStart || server.auto_start),
    headers: isPlainObject(server.headers) ? server.headers : {},
    modelSpec: typeof modelSpec === "string" ? modelSpec.trim() : modelSpec,
    providerHint: String(providerHint || "").trim(),
    variant: String(variant || "").trim(),
    models,
    agent: String(agent || "").trim(),
    autoApprove,
    permissions: Array.isArray(config.permissions) ? config.permissions : [],
    timeoutSeconds: Math.max(1, timeoutSeconds),
    heartbeatSeconds,
    reasoning,
    runDir: String(args.runDir ?? env.OPENCODE_DELEGATE_RUN_DIR ?? config.run_dir ?? "").trim(),
    resultFile: String(args.result ?? "").trim(),
    title: String(args.title ?? config.title ?? "").trim(),
    session: String(args.session ?? "").trim(),
    json: Boolean(args.json),
    quiet: Boolean(args.quiet),
    dryRun: Boolean(args.dryRun),
    printConfig: Boolean(args.printConfig),
    configFile: config.__file || null,
  }
}

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return Boolean(fallback)
  if (typeof value === "boolean") return value
  const text = String(value).trim().toLowerCase()
  if (["1", "true", "yes", "on"].includes(text)) return true
  if (["0", "false", "no", "off"].includes(text)) return false
  return Boolean(fallback)
}

function number(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}
