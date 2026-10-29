const FLAGS = {
  root: { short: "r", value: true },
  instructions: { short: "i", value: true },
  server: { short: "s", value: true },
  config: { short: "c", value: true },
  "env-file": { value: true },
  model: { short: "m", value: true },
  provider: { value: true },
  variant: { value: true },
  agent: { short: "a", value: true },
  title: { value: true },
  session: { value: true },
  timeout: { short: "t", value: true },
  heartbeat: { value: true },
  "run-dir": { value: true },
  result: { value: true },
  auto: { value: false },
  "auto-start": { value: false },
  "no-reasoning": { value: false },
  json: { value: false },
  jsonl: { value: false },
  quiet: { short: "q", value: false },
  "dry-run": { value: false },
  "print-config": { value: false },
  help: { short: "h", value: false },
  version: { short: "V", value: false },
}

const SHORT = new Map(
  Object.entries(FLAGS)
    .filter(([, spec]) => spec.short)
    .map(([name, spec]) => [spec.short, name]),
)

export class UsageError extends Error {
  constructor(message) {
    super(message)
    this.name = "UsageError"
    this.exitCode = 2
  }
}

function camel(name) {
  return name.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase())
}

export function parseArgs(argv) {
  const parsed = { _: [] }

  const assign = (name, value) => {
    const key = camel(name)
    const spec = FLAGS[name]
    if (spec.value) {
      parsed[key] = value
    } else {
      parsed[key] = true
    }
  }

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]

    if (token === "--") {
      parsed._.push(...argv.slice(i + 1))
      break
    }

    if (token.startsWith("--")) {
      let name = token.slice(2)
      let inlineValue
      const eq = name.indexOf("=")
      if (eq >= 0) {
        inlineValue = name.slice(eq + 1)
        name = name.slice(0, eq)
      }
      const spec = FLAGS[name]
      if (!spec) throw new UsageError(`unknown option --${name}`)
      if (spec.value) {
        if (inlineValue === undefined) {
          if (i + 1 >= argv.length) throw new UsageError(`--${name} needs a value`)
          inlineValue = argv[(i += 1)]
        }
        assign(name, inlineValue)
      } else {
        if (inlineValue !== undefined) throw new UsageError(`--${name} does not take a value`)
        assign(name)
      }
      continue
    }

    if (token.startsWith("-") && token !== "-") {
      const short = token.slice(1)
      const name = SHORT.get(short)
      if (!name) throw new UsageError(`unknown option -${short}`)
      const spec = FLAGS[name]
      if (spec.value) {
        if (i + 1 >= argv.length) throw new UsageError(`-${short} needs a value`)
        assign(name, argv[(i += 1)])
      } else {
        assign(name)
      }
      continue
    }

    parsed._.push(token)
  }

  if (!parsed.root && parsed._.length > 0) parsed.root = parsed._[0]
  if (!parsed.instructions && parsed._.length > 1) parsed.instructions = parsed._[1]
  if (parsed._.length > 2) {
    throw new UsageError(`unexpected positional arguments: ${parsed._.slice(2).join(" ")}`)
  }

  if (parsed.jsonl) parsed.json = true
  if (parsed.timeout !== undefined) {
    const n = Number(parsed.timeout)
    if (!Number.isFinite(n) || n <= 0) throw new UsageError("--timeout must be a positive number of seconds")
    parsed.timeout = n
  }
  if (parsed.heartbeat !== undefined) {
    const n = Number(parsed.heartbeat)
    if (!Number.isFinite(n) || n < 0) throw new UsageError("--heartbeat must be zero or a positive number of seconds")
    parsed.heartbeat = n
  }

  return parsed
}

export function usage() {
  return `opencode-delegate — run one delegated task through a running OpenCode server

USAGE
  opencode-delegate --root <dir> --instructions <file> [options]
  opencode-delegate <root> <instructions> [options]

REQUIRED
  -r, --root <dir>              Harness/runtime root. OpenCode session location; AGENTS.md,
                                opencode.json(c), .opencode/ etc. are loaded from here.
  -i, --instructions <file>     Task instructions. Relative paths resolve inside --root;
                                the resolved file must stay inside the root.

CONNECTION
  -s, --server <url>            Explicit OpenCode server URL. Otherwise OPENCODE_SERVER_URL
                                or the registered local service (opencode service start) is used.
      --auto-start              Start the registered local service if none is running.
  -c, --config <file>           config.json path (default: plugin-data, then plugin config.json).
      --env-file <file>         .env path (default: <plugin>/.env).

MODEL / AGENT
  -m, --model <name>            Model alias from config.models, provider/model, or bare model id.
      --provider <id>           Provider paired with a bare model id.
      --variant <name>          Model variant / reasoning effort (e.g. high, max).
  -a, --agent <id>              OpenCode agent (e.g. build, plan).

RUN
      --title <text>            Session title.
      --session <id>            Resume an existing OpenCode session instead of creating one.
  -t, --timeout <seconds>       Wall-clock timeout (default: config or 3600).
      --heartbeat <seconds>     Progress heartbeat interval; 0 disables (default: 30).
      --run-dir <dir>           Parent directory for run artifacts.
      --result <file>           Final result JSON path (default: <run-dir>/result.json).
      --auto                    Auto-approve permission prompts. Trusted harnesses only.
      --no-reasoning            Do not stream reasoning deltas.
      --json, --jsonl           Emit newline-delimited JSON events on stdout.
  -q, --quiet                   Suppress reasoning/text/tool progress on stdout.
      --dry-run                 Resolve everything and print the plan without prompting.
      --print-config            Print the resolved config and exit.
  -h, --help                    Show this help.
  -V, --version                 Show the runner version.

ENVIRONMENT
  OPENCODE_SERVER_URL, OPENCODE_DELEGATE_MODEL, OPENCODE_DELEGATE_PROVIDER,
  OPENCODE_DELEGATE_VARIANT, OPENCODE_DELEGATE_AGENT, OPENCODE_DELEGATE_TIMEOUT,
  OPENCODE_DELEGATE_AUTO_APPROVE, OPENCODE_DELEGATE_REASONING,
  OPENCODE_DELEGATE_RUN_DIR, OPENCODE_DELEGATE_CONFIG, OPENCODE_DELEGATE_ENV.

OUTPUT
  Human mode: lifecycle lines, "--- reasoning ---", "--- output ---", "--- tools ---",
  and a final "=== RESULT ===" block. The runner prints RUN_DIR=, RESULT_FILE= and
  SESSION_ID= lines for easy log parsing. JSON mode emits one JSON object per line.
`
}
