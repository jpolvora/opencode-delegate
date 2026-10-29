import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** Plugin install root: <plugin>/app/lib -> <plugin>. */
export const PLUGIN_ROOT = path.resolve(HERE, "../..")

/** Hermes home for the active profile. */
export function hermesHome() {
  return process.env.HERMES_HOME || path.join(os.homedir(), ".hermes")
}

/** Profile-scoped writable data directory for this plugin. */
export function pluginDataDir() {
  return path.join(hermesHome(), "plugin-data", "opencode-delegate")
}

export function pluginConfigPath() {
  return path.join(PLUGIN_ROOT, "config.json")
}

export function pluginEnvPath() {
  return path.join(PLUGIN_ROOT, ".env")
}

/** Expand a leading ~ or ~/ to the current user's home. */
export function expandHome(value) {
  const text = String(value)
  if (text === "~") return os.homedir()
  if (text.startsWith("~/")) return path.join(os.homedir(), text.slice(2))
  return text
}
