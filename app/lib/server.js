import { Service } from "@opencode/client/service"

function normalized(url) {
  return String(url).trim().replace(/\/+$/, "")
}

function stringHeaders(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const out = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") out[key] = entry
  }
  return out
}

export async function resolveServer({ url, autoStart, headers, output }) {
  const extra = stringHeaders(headers)

  if (url) {
    const base = normalized(url)
    try {
      const parsed = new URL(base)
      if (!["http:", "https:"].includes(parsed.protocol)) {
        throw new Error("only http(s) URLs are supported")
      }
    } catch (error) {
      throw new Error(`invalid --server URL ${base}: ${error.message}`)
    }

    // An explicit URL may still be the registered local service. Reuse its
    // Basic auth when the addresses match, so `--server $(opencode service status)`
    // behaves like discovery.
    let serviceHeaders = {}
    try {
      const endpoint = await Service.discover()
      if (endpoint && normalized(endpoint.url) === base) {
        serviceHeaders = Service.headers(endpoint) || {}
      }
    } catch {
      // discovery is optional here
    }

    output.log(`server: explicit ${base}`)
    return { url: base, headers: { ...serviceHeaders, ...extra }, source: "explicit" }
  }

  let endpoint
  try {
    endpoint = await Service.discover()
  } catch (error) {
    output.warn(`service discovery failed: ${error.message}`)
  }

  if (endpoint) {
    output.log(`server: discovered ${endpoint.url}`)
    return {
      url: normalized(endpoint.url),
      headers: { ...(Service.headers(endpoint) || {}), ...extra },
      source: "service",
    }
  }

  if (autoStart) {
    output.log("server: no registered service found; starting one")
    endpoint = await Service.ensure()
    output.log(`server: started ${endpoint.url}`)
    return {
      url: normalized(endpoint.url),
      headers: { ...(Service.headers(endpoint) || {}), ...extra },
      source: "service-started",
    }
  }

  throw new Error(
    "no running OpenCode server found. Start one with `opencode service start` " +
      "(or `opencode serve`), pass --server <url>, or use --auto-start.",
  )
}
