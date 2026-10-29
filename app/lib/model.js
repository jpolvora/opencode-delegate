function splitVariant(value) {
  const text = String(value)
  const hash = text.lastIndexOf("#")
  if (hash <= 0) return { model: text, variant: "" }
  return { model: text.slice(0, hash), variant: text.slice(hash + 1) }
}

function asSpecObject(value, providerHint, variantHint) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const provider = String(value.providerID ?? value.provider ?? providerHint ?? "").trim()
  const id = String(value.id ?? value.modelID ?? value.model ?? "").trim()
  const variant = String(value.variant ?? variantHint ?? "").trim()
  if (!id) throw new Error("model object needs id/model/modelID")
  return { provider, id, variant }
}

export function parseModelSpec(value, { aliases = {}, providerHint = "", variantHint = "" } = {}) {
  const seen = new Set()

  const parse = (input, hint) => {
    if (input === undefined || input === null || input === "") {
      throw new Error("no model configured; set config.model, --model, or OPENCODE_DELEGATE_MODEL")
    }

    if (typeof input === "object") {
      const spec = asSpecObject(input, hint, variantHint)
      if (!spec.provider) throw new Error(`model ${spec.id} needs a provider (config.provider or --provider)`)
      return spec
    }

    let text = String(input).trim()
    if (!text) throw new Error("model is empty")
    if (seen.has(text)) throw new Error(`model alias loop: ${text}`)
    seen.add(text)

    const withVariant = splitVariant(text)
    text = withVariant.model
    const variant = withVariant.variant || variantHint || ""

    if (Object.prototype.hasOwnProperty.call(aliases, text)) {
      const resolved = parse(aliases[text], hint)
      return { ...resolved, variant: variant || resolved.variant }
    }

    let provider = hint || ""
    let id = text
    const slash = text.indexOf("/")
    if (slash > 0) {
      provider = text.slice(0, slash)
      id = text.slice(slash + 1)
    }
    id = id.trim()
    provider = provider.trim()
    if (!id) throw new Error(`invalid model spec: ${input}`)
    if (!provider) throw new Error(`model ${id} needs a provider (config.provider or --provider)`)
    return { provider, id, variant: variant.trim() }
  }

  return parse(value, providerHint)
}

export async function resolveModel(client, root, settings, output) {
  const location = { directory: root }
  let requested

  if (!settings.modelSpec) {
    const fallback = await client.model.default({ location })
    if (!fallback.data) {
      throw new Error("no model configured and the server returned no default model")
    }
    requested = {
      provider: fallback.data.providerID,
      id: fallback.data.id || fallback.data.modelID,
      variant: settings.variant || "",
    }
    output.log(`model: server default ${requested.provider}/${requested.id}`)
  } else {
    requested = parseModelSpec(settings.modelSpec, {
      aliases: settings.models,
      providerHint: settings.providerHint,
      variantHint: settings.variant,
    })
  }

  const list = await client.model.list({ location })
  const models = list.data || []

  let info = models.find(
    (entry) =>
      entry.providerID === requested.provider &&
      (entry.id === requested.id || entry.modelID === requested.id),
  )

  if (!info) {
    const byId = models.filter((entry) => entry.id === requested.id || entry.modelID === requested.id)
    if (byId.length === 1) {
      info = byId[0]
      output.warn(
        `model ${requested.id} exists under provider ${info.providerID}, not ${requested.provider}; using ${info.providerID}/${info.id}`,
      )
    }
  }

  if (!info) {
    const suggestions = suggest(models, requested)
    throw new Error(
      `model not found: ${requested.provider}/${requested.id}` +
        (suggestions.length ? `. Closest matches: ${suggestions.join(", ")}` : ""),
    )
  }

  const variants = Array.isArray(info.variants)
    ? info.variants.map((variant) => (typeof variant === "string" ? variant : variant.id))
    : []
  let variant = requested.variant
  if (variant && !variants.includes(variant)) {
    throw new Error(
      `variant ${variant} is not available for ${info.providerID}/${info.id}` +
        (variants.length ? `. Available: ${variants.join(", ")}` : " (this model has no variants)"),
    )
  }

  const ref = { providerID: info.providerID, id: info.id }
  if (variant) ref.variant = variant

  output.log(
    `model: ${info.providerID}/${info.id}` +
      (variant ? `#${variant}` : "") +
      (info.name ? ` (${info.name})` : ""),
  )

  return { ref, info, requested }
}

function suggest(models, requested) {
  const needle = requested.id.toLowerCase()
  const provider = requested.provider.toLowerCase()
  return models
    .filter(
      (entry) =>
        entry.id.toLowerCase().includes(needle) ||
        entry.modelID.toLowerCase().includes(needle) ||
        (entry.providerID.toLowerCase() === provider && entry.id.toLowerCase().includes(needle.slice(0, 4))),
    )
    .slice(0, 8)
    .map((entry) => `${entry.providerID}/${entry.id}`)
}
