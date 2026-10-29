import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { OpenCode } from "@opencode/client"
import { detectHarness, resolveInstructions, resolveRoot } from "./instructions.js"
import { resolveModel } from "./model.js"
import { RunOutput } from "./output.js"
import { expandHome, pluginDataDir } from "./paths.js"
import { resolveServer } from "./server.js"

const EVENT_TYPES = [
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.text.started",
  "session.text.delta",
  "session.text.ended",
  "session.reasoning.started",
  "session.reasoning.delta",
  "session.reasoning.ended",
  "session.tool.called",
  "session.tool.success",
  "session.tool.failed",
  "session.tool.progress",
  "session.step.started",
  "session.step.ended",
  "session.step.failed",
  "session.status",
  "session.idle",
  "session.retry.scheduled",
  "session.compaction.started",
  "session.compaction.ended",
  "session.compaction.failed",
  "permission.asked",
  "permission.replied",
]

export async function runTask(settings) {
  const root = await resolveRoot(settings.root)
  const instructions = await resolveInstructions({ root, value: settings.instructions })
  const harness = await detectHarness(root.real)

  const runId = makeRunId()
  const parent = settings.runDir
    ? path.resolve(expandHome(settings.runDir))
    : path.join(pluginDataDir(), "runs")
  const runDir = path.join(parent, runId)
  const resultFile = settings.resultFile
    ? path.resolve(expandHome(settings.resultFile))
    : path.join(runDir, "result.json")

  const out = new RunOutput({
    runDir,
    json: settings.json,
    quiet: settings.quiet,
    reasoning: settings.reasoning,
  })
  out.init()

  const startedAt = Date.now()
  const startedAtIso = new Date(startedAt).toISOString()

  out.plain(`RUN_DIR=${runDir}`)
  out.plain(`RESULT_FILE=${resultFile}`)
  out.log(`run ${runId}`)
  out.log(`root ${root.real}`)
  out.log(`instructions ${instructions.relative} (${instructions.bytes} bytes)`)
  out.log(`harness ${harness.files.length ? harness.files.join(", ") : "(none detected)"}`)
  out.record("run.started", {
    run_id: runId,
    pid: process.pid,
    started_at: startedAtIso,
    run_dir: runDir,
    result_file: resultFile,
    root: root.real,
    instructions: {
      relative: instructions.relative,
      bytes: instructions.bytes,
      sha256: instructions.sha256,
    },
    harness,
    config_file: settings.configFile,
  })

  await writeJsonAtomic(path.join(runDir, "meta.json"), {
    run_id: runId,
    started_at: startedAtIso,
    pid: process.pid,
    cwd: process.cwd(),
    node: process.version,
    argv: process.argv.slice(2),
    root: root.real,
    instructions: {
      relative: instructions.relative,
      path: instructions.path,
      bytes: instructions.bytes,
      sha256: instructions.sha256,
    },
    harness,
    config_file: settings.configFile,
  })

  const state = {
    server: null,
    serverInfo: null,
    client: null,
    model: null,
    agent: "",
    session: null,
    resumed: false,
    terminal: null,
    promptError: null,
    timedOut: false,
    signalName: "",
    controller: null,
    iterator: null,
    timeoutTimer: null,
    heartbeatTimer: null,
    permissionDecisions: [],
    turnStartedAt: 0,
    dryRun: Boolean(settings.dryRun),
  }

  try {
    state.server = await resolveServer({
      url: settings.serverUrl,
      autoStart: settings.autoStart,
      headers: settings.headers,
      output: out,
    })
    out.record("run.server", { url: state.server.url, source: state.server.source })

    state.client = OpenCode.make({
      baseUrl: state.server.url,
      headers: state.server.headers,
    })

    state.serverInfo = await state.client.server.info()
    out.log(
      `server ${state.serverInfo.version || "unknown"}` +
        (state.serverInfo.pid ? ` pid ${state.serverInfo.pid}` : ""),
    )
    out.record("run.server_info", state.serverInfo)

    state.model = await resolveModel(state.client, root.real, settings, out)

    if (settings.agent) {
      const agents = await state.client.agent.list({ location: { directory: root.real } })
      const match = (agents.data || []).find(
        (entry) => entry.id === settings.agent || entry.name === settings.agent,
      )
      if (!match) {
        const available = (agents.data || []).map((entry) => entry.id).join(", ")
        throw new Error(`agent not found: ${settings.agent}. Available: ${available || "(none)"}`)
      }
      state.agent = match.id
      out.log(`agent: ${match.id}`)
    }

    if (settings.dryRun) {
      const plan = {
        ok: true,
        dry_run: true,
        run_id: runId,
        run_dir: runDir,
        result_file: resultFile,
        root: root.real,
        instructions: {
          relative: instructions.relative,
          bytes: instructions.bytes,
          sha256: instructions.sha256,
        },
        harness,
        server: { url: state.server.url, source: state.server.source },
        server_version: state.serverInfo.version,
        model: modelSummary(state.model),
        agent: state.agent || null,
        timeout_seconds: settings.timeoutSeconds,
        auto_approve: settings.autoApprove,
      }
      out.log("dry run: plan is valid; no session was created")
      out.record("run.dry_run", plan)
      await writeJsonAtomic(resultFile, plan)
      await out.close()
      return 0
    }

    const permissions = Array.isArray(settings.permissions) ? [...settings.permissions] : []
    if (settings.autoApprove) {
      permissions.push({ action: "*", resource: "*", effect: "allow" })
      out.warn("auto-approve enabled: permission prompts will be allowed automatically")
    }

    if (settings.session) {
      state.session = await state.client.session.get({ sessionID: settings.session })
      state.resumed = true
      out.log(`resuming session ${state.session.id}`)
      const existingLocation = state.session.location?.directory
      if (existingLocation && path.resolve(existingLocation) !== root.real) {
        out.warn(
          `session location ${existingLocation} differs from --root ${root.real}; the session keeps its original location`,
        )
      }
      if (state.agent && state.session.agent !== state.agent) {
        await state.client.session.switchAgent({ sessionID: state.session.id, agent: state.agent })
      }
      await state.client.session.switchModel({ sessionID: state.session.id, model: state.model.ref })
    } else {
      state.session = await state.client.session.create({
        location: { directory: root.real },
        title:
          settings.title ||
          `Hermes delegated task — ${instructions.relative === "-" ? "stdin" : instructions.relative}`,
        ...(state.agent ? { agent: state.agent } : {}),
        model: state.model.ref,
        ...(permissions.length ? { permissions } : {}),
      })
      out.log(`created session ${state.session.id}`)
    }

    out.plain(`SESSION_ID=${state.session.id}`)
    out.record("run.session", {
      id: state.session.id,
      resumed: state.resumed,
      title: state.session.title,
      model: state.model.ref,
      agent: state.agent || state.session.agent || null,
      location: state.session.location,
    })

    state.controller = new AbortController()
    const eventStream = state.client.event.subscribe({
      types: EVENT_TYPES,
      signal: state.controller.signal,
    })
    state.iterator = eventStream[Symbol.asyncIterator]()

    const first = await state.iterator.next()
    if (first.done) throw new Error("event stream closed before it connected")
    if (first.value?.type !== "server.connected") {
      out.warn(`event stream started with ${first.value?.type || "an unknown event"}`)
    }
    out.log("event stream connected")

    let lastEventAt = Date.now()
    const onSignal = async (signal) => {
      if (state.signalName) return
      state.signalName = signal
      out.warn(`received ${signal}; interrupting session`)
      state.controller?.abort()
      try {
        if (state.session?.id) {
          await state.client.session.interrupt({ sessionID: state.session.id })
        }
      } catch (error) {
        out.warn(`interrupt failed: ${formatError(error)}`)
      }
    }
    process.once("SIGINT", onSignal)
    process.once("SIGTERM", onSignal)
    state.signalHandlers = { onSignal }

    state.timeoutTimer = setTimeout(async () => {
      state.timedOut = true
      out.warn(`timeout after ${settings.timeoutSeconds}s; interrupting session`)
      state.controller?.abort()
      try {
        if (state.session?.id) {
          await state.client.session.interrupt({ sessionID: state.session.id })
        }
      } catch (error) {
        out.warn(`interrupt failed: ${formatError(error)}`)
      }
    }, settings.timeoutSeconds * 1000)

    if (settings.heartbeatSeconds > 0) {
      const every = Math.max(1000, Math.min(5000, settings.heartbeatSeconds * 1000))
      state.heartbeatTimer = setInterval(() => {
        if (Date.now() - lastEventAt < settings.heartbeatSeconds * 1000) return
        out.log(`still running (${Math.round((Date.now() - startedAt) / 1000)}s)`)
        out.record("run.heartbeat", {
          run_id: runId,
          session_id: state.session.id,
          elapsed_seconds: Math.round((Date.now() - startedAt) / 1000),
        })
        lastEventAt = Date.now()
      }, every)
    }

    state.turnStartedAt = Date.now()
    const promptPromise = state.client.session
      .prompt({
        sessionID: state.session.id,
        text: instructions.text,
        metadata: {
          source: "hermes-opencode-delegate",
          run_id: runId,
          instructions: instructions.relative,
        },
      })
      .then(() => {
        out.log("prompt queued")
        out.record("run.prompt", {
          session_id: state.session.id,
          instructions: instructions.relative,
          bytes: instructions.bytes,
        })
      })
      .catch((error) => {
        state.promptError = error
        state.terminal = state.terminal || { kind: "prompt.error", outcome: "failed", error }
        out.warn(`prompt failed: ${formatError(error)}`)
        state.controller?.abort()
      })

    while (!state.terminal) {
      let next
      try {
        next = await state.iterator.next()
      } catch (error) {
        if (state.timedOut || state.signalName || state.controller?.signal.aborted) break
        throw error
      }
      if (next.done) {
        out.warn("event stream ended before a terminal event")
        break
      }

      const event = next.value
      if (!event || event.type === "server.connected") continue
      if (!isForSession(event, state.session.id)) continue

      lastEventAt = Date.now()
      out.record(event.type, capData(event.data || {}))

      switch (event.type) {
        case "session.execution.started":
          out.log("execution started")
          break
        case "session.reasoning.started":
          out.section("reasoning")
          break
        case "session.reasoning.delta":
          out.reasoningDelta(event.data?.delta)
          break
        case "session.reasoning.ended":
          out.newline()
          break
        case "session.text.started":
          out.section("output")
          break
        case "session.text.delta":
          out.text(event.data?.delta)
          break
        case "session.text.ended":
          out.newline()
          break
        case "session.tool.called":
          out.log(`tool called ${event.data?.id || "?"} ${summarizeToolInput(event.data?.input)}`)
          break
        case "session.tool.success":
          out.log(`tool ok ${event.data?.id || "?"}`)
          break
        case "session.tool.failed":
          out.warn(`tool failed ${event.data?.id || "?"}: ${formatError(event.data?.error)}`)
          break
        case "session.retry.scheduled":
          out.warn(
            `retry ${event.data?.attempt || "?"} scheduled: ${formatError(event.data?.error)}`,
          )
          break
        case "session.status":
          if (event.data?.status?.type === "retry") {
            out.warn(`provider retry: ${event.data.status.message || "retrying"}`)
          }
          break
        case "session.compaction.started":
          out.log("compaction started")
          break
        case "session.compaction.ended":
          out.log("compaction ended")
          break
        case "session.compaction.failed":
          out.warn(`compaction failed: ${formatError(event.data?.error)}`)
          break
        case "permission.asked":
          await replyPermission({
            client: state.client,
            event,
            autoApprove: settings.autoApprove,
            out,
            decisions: state.permissionDecisions,
          })
          break
        case "permission.replied":
          out.log(`permission ${event.data?.reply || "replied"}`)
          break
        case "session.execution.succeeded":
          state.terminal = { kind: event.type, outcome: "succeeded" }
          out.log("execution succeeded")
          break
        case "session.execution.failed":
          state.terminal = { kind: event.type, outcome: "failed", error: event.data?.error }
          out.warn(`execution failed: ${formatError(event.data?.error)}`)
          break
        case "session.execution.interrupted":
          state.terminal = {
            kind: event.type,
            outcome: "interrupted",
            reason: event.data?.reason || "interrupted",
          }
          out.warn(`execution interrupted: ${state.terminal.reason}`)
          break
        case "session.idle":
          if (!state.terminal) state.terminal = { kind: event.type, outcome: null }
          out.log("session idle")
          break
        case "session.step.failed":
          out.warn(`step failed: ${formatError(event.data?.error)}`)
          break
        default:
          break
      }
    }

    await promptPromise

    if (!state.terminal) {
      if (state.timedOut) {
        state.terminal = { kind: "timeout", outcome: "interrupted", error: new Error("timeout") }
      } else if (state.signalName) {
        state.terminal = {
          kind: "signal",
          outcome: "interrupted",
          error: new Error(`interrupted by ${state.signalName}`),
        }
      } else if (state.promptError) {
        state.terminal = { kind: "prompt.error", outcome: "failed", error: state.promptError }
      } else {
        state.terminal = {
          kind: "stream-ended",
          outcome: "failed",
          error: new Error("event stream ended before the session reached a terminal state"),
        }
      }
    }
  } catch (error) {
    state.terminal = state.terminal || { kind: "runner.error", outcome: "failed", error }
    out.warn(`run failed: ${formatError(error)}`)
  } finally {
    if (state.timeoutTimer) clearTimeout(state.timeoutTimer)
    if (state.heartbeatTimer) clearInterval(state.heartbeatTimer)
    if (state.signalHandlers?.onSignal) {
      process.removeListener("SIGINT", state.signalHandlers.onSignal)
      process.removeListener("SIGTERM", state.signalHandlers.onSignal)
    }
    try {
      state.controller?.abort()
    } catch {
      // ignore
    }
    try {
      await state.iterator?.return?.()
    } catch {
      // ignore
    }
  }

  let finalSession = state.session
  let messages = { data: [] }

  if (state.client && state.session?.id) {
    try {
      await withTimeout(
        state.client.experimental.session.wait({ sessionID: state.session.id }),
        15000,
        "session wait",
      )
    } catch {
      // best effort: the session may already be idle or the server may not support wait
    }
    try {
      finalSession = await state.client.session.get({ sessionID: state.session.id })
    } catch (error) {
      out.warn(`could not refresh session: ${formatError(error)}`)
    }
    try {
      messages = await state.client.message.list({ sessionID: state.session.id, order: "asc" })
    } catch (error) {
      out.warn(`could not read messages: ${formatError(error)}`)
    }
  }

  const finishedAt = Date.now()
  const result = buildResult({
    settings,
    runId,
    runDir,
    resultFile,
    startedAt,
    finishedAt,
    root: root.real,
    instructions,
    harness,
    server: state.server,
    serverInfo: state.serverInfo,
    model: state.model,
    agent: state.agent,
    session: finalSession || state.session,
    resumed: state.resumed,
    terminal: state.terminal,
    messages,
    turnStartedAt: state.turnStartedAt,
    permissionDecisions: state.permissionDecisions,
    dryRun: state.dryRun,
  })

  await writeJsonAtomic(resultFile, result)
  out.finalText(result.text)
  out.log(
    `finished outcome=${result.outcome} ok=${result.ok} duration=${Math.round(
      result.run.duration_ms / 1000,
    )}s`,
  )
  out.record("run.finished", result)
  await out.close()

  if (state.signalName) return 130
  return result.ok ? 0 : 1
}

function makeRunId() {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z")
  return `ocd_${stamp}_${crypto.randomBytes(3).toString("hex")}`
}

function isForSession(event, sessionID) {
  const data = event?.data
  if (!data || typeof data !== "object") return false
  return data.sessionID === sessionID || data.session?.id === sessionID
}

function modelSummary(model) {
  if (!model) return null
  return {
    providerID: model.ref.providerID,
    id: model.ref.id,
    variant: model.ref.variant || null,
    name: model.info?.name || null,
  }
}

function buildResult({
  settings,
  runId,
  runDir,
  resultFile,
  startedAt,
  finishedAt,
  root,
  instructions,
  harness,
  server,
  serverInfo,
  model,
  agent,
  session,
  resumed,
  terminal,
  messages,
  turnStartedAt,
  permissionDecisions,
  dryRun,
}) {
  const allAssistant = (messages.data || []).filter((message) => message.type === "assistant")
  const currentTurn = allAssistant.filter(
    (message) => !turnStartedAt || !message.time?.created || message.time.created >= turnStartedAt - 5000,
  )
  const assistant = currentTurn.length ? currentTurn : allAssistant
  const lastTextMessage = [...assistant]
    .reverse()
    .find((message) => (message.content || []).some((part) => part.type === "text" && part.text))
  const text = lastTextMessage
    ? (lastTextMessage.content || [])
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("")
    : ""
  const reasoning = assistant
    .flatMap((message) =>
      (message.content || [])
        .filter((part) => part.type === "reasoning")
        .map((part) => part.text),
    )
    .filter(Boolean)
    .join("\n\n")

  const tools = assistant.flatMap((message) =>
    (message.content || [])
      .filter((part) => part.type === "tool")
      .map((part) => ({
        id: part.id,
        name: part.name,
        status: part.state?.status || "unknown",
        input: redactValue(part.state?.input ?? null),
        error: part.state?.error ? formatError(part.state.error) : null,
      })),
  )

  const outcome = session?.outcome || terminal?.outcome || "unknown"
  const error = terminal?.error || null
  const ok = outcome === "succeeded" && !error
  const lastAssistant = assistant.at(-1)

  return {
    ok,
    dry_run: Boolean(dryRun),
    run_id: runId,
    outcome,
    error: error ? formatError(error) : null,
    terminal: terminal
      ? {
          kind: terminal.kind,
          outcome: terminal.outcome,
          reason: terminal.reason || null,
        }
      : null,
    text,
    reasoning,
    tools,
    permissions: permissionDecisions,
    run: {
      started_at: new Date(startedAt).toISOString(),
      finished_at: new Date(finishedAt).toISOString(),
      duration_ms: finishedAt - startedAt,
    },
    root,
    instructions: {
      relative: instructions.relative,
      path: instructions.path,
      bytes: instructions.bytes,
      sha256: instructions.sha256,
    },
    harness,
    server: server
      ? {
          url: server.url,
          source: server.source,
          version: serverInfo?.version || null,
          pid: serverInfo?.pid || null,
        }
      : null,
    model: modelSummary(model),
    agent: agent || session?.agent || null,
    session: session
      ? {
          id: session.id,
          resumed,
          title: session.title || null,
          outcome: session.outcome || null,
          location: session.location || null,
          cost: session.cost ?? null,
          tokens: session.tokens ?? null,
          model: session.model || model?.ref || null,
          time: session.time || null,
        }
      : null,
    usage: {
      session: session
        ? {
            cost: session.cost ?? null,
            tokens: session.tokens ?? null,
          }
        : null,
      last_message: lastAssistant
        ? {
            cost: lastAssistant.cost ?? null,
            tokens: lastAssistant.tokens ?? null,
            finish: lastAssistant.finish ?? null,
          }
        : null,
    },
    counts: {
      assistant_messages: assistant.length,
      tool_calls: tools.length,
      tools_failed: tools.filter((tool) => tool.status === "error").length,
    },
    artifacts: {
      run_dir: runDir,
      result: resultFile,
      events: path.join(runDir, "events.jsonl"),
      log: path.join(runDir, "run.log"),
      meta: path.join(runDir, "meta.json"),
    },
    config_file: settings.configFile,
  }
}

async function replyPermission({ client, event, autoApprove, out, decisions }) {
  const data = event.data || {}
  const decision = autoApprove ? "always" : "reject"
  const message = autoApprove
    ? "auto-approved by Hermes opencode-delegate"
    : "non-interactive Hermes run; rerun with --auto or grant this permission in the harness"

  try {
    await client.permission.reply({
      sessionID: data.sessionID,
      requestID: data.id,
      decision,
      message,
    })
  } catch (error) {
    out.warn(`could not reply to permission ${data.id}: ${formatError(error)}`)
    return
  }

  const record = {
    request_id: data.id,
    action: data.action || "unknown",
    resources: Array.isArray(data.resources) ? data.resources : [],
    decision,
    at: new Date().toISOString(),
  }
  decisions.push(record)
  out.log(`permission ${decision}: ${record.action} ${record.resources.join(", ")}`.trim())
  out.record("permission.decision", record)
}

function summarizeToolInput(input) {
  if (!input || typeof input !== "object") return ""
  const redacted = redactValue(input)
  for (const key of ["command", "path", "filePath", "pattern", "query", "url", "description"]) {
    if (typeof redacted[key] === "string" && redacted[key].trim()) {
      return `${key}=${truncate(redacted[key].replace(/\s+/g, " "), 220)}`
    }
  }
  return truncate(JSON.stringify(redacted), 260)
}

function redactValue(value, depth = 0) {
  if (depth > 5) return "[depth]"
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, depth + 1))
  if (value && typeof value === "object") {
    const out = {}
    for (const [key, entry] of Object.entries(value)) {
      if (/token|secret|password|api[_-]?key|authorization|credential/i.test(key)) {
        out[key] = "[redacted]"
      } else {
        out[key] = redactValue(entry, depth + 1)
      }
    }
    return out
  }
  if (typeof value === "string") return truncate(value, 4000)
  return value
}

function capData(value, depth = 0) {
  if (depth > 6) return "[depth]"
  if (Array.isArray(value)) return value.map((entry) => capData(entry, depth + 1))
  if (value && typeof value === "object") {
    const out = {}
    for (const [key, entry] of Object.entries(value)) out[key] = capData(entry, depth + 1)
    return out
  }
  if (typeof value === "string") return truncate(value, 4000)
  return value
}

function truncate(text, max) {
  const value = String(text)
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

function formatError(error) {
  if (!error) return ""
  if (typeof error === "string") return error
  if (typeof error.message === "string" && error.message) return error.message
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8")
  await fs.rename(tmp, file)
}
