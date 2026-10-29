# opencode-delegate

[Website](https://jpolvora.github.io/opencode-delegate/) · [GitHub](https://github.com/jpolvora/opencode-delegate)

Hermes Agent plugin for running **one delegated task** on an already-running OpenCode
server. A small Node runner uses [`@opencode/client`](https://opencode.ai/v2/docs/build/client/)
to create an OpenCode session at a harness root, submit an instructions file, stream
reasoning/text/tool events, and persist a durable `result.json`.

This is deliberately not an interactive TUI and not `opencode run`:

| | `opencode run` | `opencode-delegate` |
|---|---|---|
| Server | Starts/uses CLI service | Connects to the running server |
| Session root | Current directory | Explicit `--root` harness |
| Prompt | CLI argument | File inside the root |
| Streaming | Terminal output | Live reasoning/text/tool events + NDJSON |
| Result | Terminal text | `result.json` + `events.jsonl` + `run.log` |
| Hermes orchestration | Foreground | Background process, poll/log/kill |

## Install

```bash
cd "${HERMES_HOME:-$HOME/.hermes}/plugins/opencode-delegate"
npm install --omit=dev
hermes plugins validate .
```

Enable the plugin (optional; it exposes the namespaced skill `opencode-delegate:dispatch`):

```bash
hermes plugins enable opencode-delegate
```

The operational skill is also linked into the normal skills tree so Hermes sees it in
`<available_skills>`:

```text
~/.hermes/skills/autonomous-ai-agents/opencode-delegate -> ~/.hermes/plugins/opencode-delegate/skills/dispatch
```

## Prerequisites

- Node.js >= 20.
- OpenCode installed and a server already running (`opencode service status`).
- The server already authenticated with whatever providers you use.
- A harness directory containing `AGENTS.md`, `opencode.json(c)`, `.opencode/`, project
  skills, etc. The runner only sets the session location to this root; OpenCode loads the
  harness itself.

The runner does **not** start, install, or authenticate OpenCode. If discovery fails, it
tells you to start the service or pass `--server`.

## Usage

```bash
PLUGIN="${HERMES_HOME:-$HOME/.hermes}/plugins/opencode-delegate"
RUNNER="$PLUGIN/bin/opencode-delegate"

"$RUNNER" \
  --root /path/to/harness \
  --instructions .hermes/tasks/task.md \
  --model opencode-go/deepseek-v4.1-flash \
  --agent build
```

The runner prints:

```text
RUN_DIR=/.../runs/ocd_...
RESULT_FILE=/.../runs/ocd_.../result.json
SESSION_ID=ses_...
```

Human mode streams `--- reasoning ---`, `--- output ---`, tool markers, and a final
`=== RESULT ===` block. JSON mode (`--json` / `--jsonl`) emits one JSON object per line.

## Configuration

The runner loads, in order:

1. `--config <file>` / `OPENCODE_DELEGATE_CONFIG`
2. `~/.hermes/plugin-data/opencode-delegate/config.json` (preferred per-profile override)
3. `<plugin>/config.json`

`<plugin>/.env` is loaded first without overriding the shell environment.

```json
{
  "server": { "url": "", "auto_start": false, "headers": {} },
  "provider": "opencode-go",
  "model": "deepseek-v4.1-flash",
  "variant": "",
  "models": {
    "fast": "opencode-go/minimax-m3.1-flash",
    "review": "opencode-go/deepseek-v4-pro"
  },
  "agent": "build",
  "auto_approve": false,
  "permissions": [],
  "timeout_seconds": 3600,
  "heartbeat_seconds": 30,
  "reasoning": true,
  "run_dir": ""
}
```

- `provider` + bare `model` follows OpenCode CLI semantics.
- `model` may instead be `provider/model` or an alias from `models`.
- Empty `model` asks the server for its default model.
- `--model`, `--provider`, `--variant`, `--agent` override config.
- `server.url` empty means "discover the registered local service".
- `server.auto_start` or `--auto-start` starts the registered service if none is running.
- `auto_approve` / `--auto` appends an allow-all session rule. Trusted harnesses only.
- `permissions` is passed to `session.create` as extra OpenCode permission rules.

`.env` equivalents:

```text
OPENCODE_SERVER_URL=
OPENCODE_DELEGATE_MODEL=
OPENCODE_DELEGATE_PROVIDER=
OPENCODE_DELEGATE_VARIANT=
OPENCODE_DELEGATE_AGENT=
OPENCODE_DELEGATE_TIMEOUT=
OPENCODE_DELEGATE_AUTO_APPROVE=
OPENCODE_DELEGATE_REASONING=
OPENCODE_DELEGATE_RUN_DIR=
OPENCODE_DELEGATE_CONFIG=
OPENCODE_DELEGATE_ENV=
OPENCODE_DELEGATE_ROOT=
OPENCODE_DELEGATE_INSTRUCTIONS=
```

## How it works

1. Validate `--root` and the instructions file (must resolve inside root; symlink escapes
   are rejected).
2. Discover the local OpenCode service (`Service.discover()`), or use `--server`.
   For a discovered service, `Service.headers()` supplies its Basic auth.
3. `OpenCode.make({ baseUrl, headers })`.
4. Resolve the model against `client.model.list()`; validate the agent against
   `client.agent.list()`.
5. `client.session.create({ location: { directory: root }, model, agent, permissions })`
   or resume `--session`.
6. Subscribe to `client.event.subscribe({ types, signal })` **before** prompting.
7. `client.session.prompt({ text: instructions })`.
8. Stream `session.reasoning.delta`, `session.text.delta`, tool events, and permission
   prompts until `session.execution.succeeded|failed|interrupted` or `session.idle`.
9. Fetch the final session and messages, write `result.json`, and exit `0` only when
   `ok=true`.

The runner handles `SIGINT`/`SIGTERM` by interrupting the session and writing a partial
result. `--timeout` does the same on a wall-clock deadline.

## Run artifacts

```text
~/.hermes/plugin-data/opencode-delegate/runs/<run_id>/
├── meta.json
├── events.jsonl
├── run.log
└── result.json
```

See `skills/dispatch/references/result-schema.md` for every field.

## Layout

```text
opencode-delegate/
├── plugin.yaml
├── __init__.py                 # registers the dispatch skill
├── config.json / config.example.json / config.schema.json
├── .env.example
├── main.js                     # compatibility entrypoint -> app/main.js
├── bin/opencode-delegate       # shell launcher
├── app/
│   ├── main.js                 # CLI entry
│   └── lib/
│       ├── args.js
│       ├── config.js
│       ├── env.js
│       ├── instructions.js
│       ├── model.js
│       ├── output.js
│       ├── paths.js
│       ├── run.js
│       └── server.js
└── skills/dispatch/
    ├── SKILL.md
    └── references/result-schema.md
```

## Verification

```bash
node --check app/main.js
for f in app/lib/*.js; do node --check "$f"; done
hermes plugins validate .
"$PWD/bin/opencode-delegate" --version
"$PWD/bin/opencode-delegate" --root <ROOT> --instructions <FILE> --dry-run
```

Smoke test against the running server with a free model:

```bash
printf 'Reply with exactly: OPENCODE_DELEGATE_OK. Do not use tools.\n' > <ROOT>/smoke.md
"$PWD/bin/opencode-delegate" --root <ROOT> --instructions smoke.md \
  --model opencode/flint-40b-free --timeout 120 --heartbeat 0
```

## Notes

- `@opencode/client` is pinned to the server generation in `package.json` (currently `2.2.1`).
  If the OpenCode server moves to another major/minor, install the matching client with
  `npm install @opencode/client@<server-version>` and re-run the smoke test.
- The runner connects to the server; it does not export or read provider credentials.
- Tool inputs are secret-redacted and truncated in `result.json`.
- `events.jsonl` records raw OpenCode events with large strings capped at ~4 KB.
- Use one writer per root. Use git worktrees for parallel implementation tasks.
