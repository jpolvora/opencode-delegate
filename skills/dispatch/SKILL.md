---
name: opencode-delegate
description: "Dispatch one delegated task to the already-running OpenCode server through the bundled @opencode/client runner; background it, stream reasoning/text, and collect result.json."
version: 1.0.0
author: Hermes Agent
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    tags: [OpenCode, delegation, background, node, opencode-client, harness, reasoning-stream]
    related_skills: [opencode, coding-agent-delegation, hermes-agent]
---

# OpenCode Delegate

Dispatch **one** delegated task to the user's already-running OpenCode server. The bundled
Node runner (`@opencode/client`) creates an OpenCode session at a harness root, submits an
instructions file, subscribes to the live event stream, prints reasoning/text/tool progress,
and writes a durable `result.json`.

Use this instead of `opencode run` when you want:

- background execution managed by Hermes (`terminal(background=true)`),
- live reasoning/text streaming while the task runs,
- a machine-readable result artifact after it finishes,
- a specific harness root (`AGENTS.md`, `opencode.json(c)`, `.opencode/`, skills),
- a resumable OpenCode session ID.

The runner **does not** start, install, or authenticate OpenCode. The server is already
running and authenticated. It only discovers the registered local service or connects to
`--server <url>`.

## Paths

```bash
PLUGIN="${HERMES_HOME:-$HOME/.hermes}/plugins/opencode-delegate"
RUNNER="$PLUGIN/bin/opencode-delegate"
```

The Hermes terminal tool uses a persistent shell, so `$RUNNER` persists between calls. If a
profile disables persistent shells, use the full path in each command.

## Prerequisites (check once per session)

```bash
"$RUNNER" --version
opencode service status              # prints the server URL
```

- If `opencode service status` prints a URL, the runner discovers it automatically.
- If no server is running: `opencode service start` (or use `--auto-start`).
- If the server is remote/custom: pass `--server http://host:port` or set
  `OPENCODE_SERVER_URL` in the plugin `.env`.

## Dispatch Procedure

### 1. Choose the harness root

`--root` is the OpenCode session location **and** the harness directory. OpenCode loads
`AGENTS.md`, `opencode.json` / `opencode.jsonc`, `.opencode/`, project skills, and project
config from there. Use the repository/worktree the task should modify.

Do not use `$HOME` or `/` unless the task genuinely needs that scope.

### 2. Write the instructions file inside the root

The runner rejects absolute paths and symlinks that escape the root. Put the file in a
hidden task directory so it does not pollute the repo:

```bash
mkdir -p "<ROOT>/.hermes/tasks"
```

Write a self-contained task brief:

- goal and context,
- constraints/non-goals,
- files or areas to inspect,
- acceptance criteria and tests to run,
- exactly what the final response should contain.

Example path: `<ROOT>/.hermes/tasks/auth-refresh-20261029.md`.

### 3. Start the runner in the background

```text
terminal(
  command="\"$RUNNER\" --root <ROOT> --instructions .hermes/tasks/<FILE>.md --model <MODEL> --agent build",
  workdir="<ROOT>",
  background=true,
  notify_on_complete=true
)
```

- **No `pty=true`** — the runner is non-interactive.
- `notify_on_complete=true` gives Hermes a new turn when the run finishes.
- Model defaults come from `config.json`; pass `--model` when the task needs another model.
- Use `--model fast` / `--model review` for aliases defined in `config.json`, or an exact
  `provider/model` from `opencode models`.
- Use `--agent plan` for read-only analysis, `--agent build` for edits (default).

The runner prints these lines early for log parsing:

```text
RUN_DIR=/.../runs/ocd_...
RESULT_FILE=/.../runs/ocd_.../result.json
SESSION_ID=ses_...
```

`SESSION_ID` is the **OpenCode** session. Do not confuse it with the Hermes process
`session_id` returned by `terminal`.

### 4. Monitor with the process tools

```text
process(action="poll", session_id="<HERMES_PROCESS_ID>")
process(action="log", session_id="<HERMES_PROCESS_ID>")
```

Poll every 30–60 seconds; do not busy-loop. The log contains:

```text
[opencode-delegate] ...
--- reasoning ---
...
--- output ---
...
[opencode-delegate] tool called ...
[opencode-delegate] tool ok ...
[opencode-delegate] execution succeeded
=== RESULT ===
...
=== END RESULT ===
```

Reasoning is streamed only when the selected model emits it. A model can finish with no
reasoning section; that is normal.

### 5. Read the result artifact

When the process exits, read:

```text
read_file(path="<RUN_DIR>/result.json")
```

Report to the user:

- `text` — the final answer/output,
- `outcome` and `ok`,
- files changed, tests run, and remaining risks (from `text` / `tools`),
- `usage` — cost and token counts when useful,
- `permissions` — any prompts the runner rejected,
- on failure: `error`, `terminal`, and the last relevant log lines.

Do **not** dump the full reasoning trace unless the user asks for it. Summarize it.

### 6. Cancel / clean up

The process exits by itself. To cancel:

```text
process(action="kill", session_id="<HERMES_PROCESS_ID>")
```

The runner traps `SIGTERM` / `SIGINT`, interrupts the OpenCode session, and still writes a
partial `result.json` when it can. Inspect `result.json` and `events.jsonl` after a kill.

## Arguments

| Argument | Meaning |
|---|---|
| `--root`, `-r` | Harness/runtime root; OpenCode session location. Required. |
| `--instructions`, `-i` | Task brief. Relative to root; must resolve inside root. Required. |
| `--server`, `-s` | Explicit OpenCode server URL. Default: `OPENCODE_SERVER_URL` or registered local service. |
| `--auto-start` | Start the registered local service if none is running. |
| `--config`, `-c` | Alternate `config.json`. |
| `--env-file` | Alternate `.env` (default: `<plugin>/.env`). |
| `--model`, `-m` | Alias (`fast`, `review`), `provider/model`, or bare model id. |
| `--provider` | Provider paired with a bare model id. |
| `--variant` | Model variant / reasoning effort, e.g. `high`, `max`; also `provider/model#variant`. |
| `--agent`, `-a` | OpenCode agent id, e.g. `build`, `plan`. |
| `--title` | Session title. |
| `--session` | Resume an existing OpenCode session instead of creating one. |
| `--timeout`, `-t` | Wall-clock seconds (default: config or 3600). |
| `--heartbeat` | Progress heartbeat seconds; `0` disables (default: 30). |
| `--run-dir` | Parent directory for run artifacts. |
| `--result` | Exact result JSON path. |
| `--auto` | Auto-approve permission prompts. **Trusted harnesses only.** |
| `--no-reasoning` | Do not stream reasoning deltas. |
| `--json` / `--jsonl` | Emit newline-delimited JSON events on stdout. |
| `--quiet`, `-q` | Suppress reasoning/text/tool progress; final result still prints. |
| `--dry-run` | Resolve server/model/harness and validate paths without prompting. |
| `--print-config` | Print the resolved config and exit. |

## Configuration

`config.json` lives in the plugin directory, or in
`~/.hermes/plugin-data/opencode-delegate/config.json` (preferred for per-profile overrides).
The runner also loads `<plugin>/.env` without overriding the shell environment.

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
- `model` may instead be `provider/model` or an alias.
- If no model is configured, the runner asks the OpenCode server for its default model.
- `--model` / `--provider` / `--variant` / `--agent` override config.
- `.env` equivalents: `OPENCODE_SERVER_URL`, `OPENCODE_DELEGATE_MODEL`,
  `OPENCODE_DELEGATE_PROVIDER`, `OPENCODE_DELEGATE_VARIANT`,
  `OPENCODE_DELEGATE_AGENT`, `OPENCODE_DELEGATE_TIMEOUT`,
  `OPENCODE_DELEGATE_AUTO_APPROVE`, `OPENCODE_DELEGATE_REASONING`,
  `OPENCODE_DELEGATE_RUN_DIR`.

## Examples

### Code change in a repo

```bash
mkdir -p /home/jone/project/.hermes/tasks
cat > /home/jone/project/.hermes/tasks/retry-auth-20261029.md <<'EOF'
Add retry-with-backoff to the auth client (src/auth/client.ts).
Keep the public API unchanged. Add unit tests for 429 and 5xx retries.
Run `npm test -- auth` and report files changed plus test output.
EOF
```

```text
terminal(
  command="\"$RUNNER\" --root /home/jone/project --instructions .hermes/tasks/retry-auth-20261029.md --model opencode-go/deepseek-v4.1-flash --agent build --timeout 3600",
  workdir="/home/jone/project",
  background=true,
  notify_on_complete=true
)
```

### Read-only review with a stronger model

```text
terminal(
  command="\"$RUNNER\" --root /home/jone/project --instructions .hermes/tasks/review.md --model review --agent plan",
  workdir="/home/jone/project",
  background=true,
  notify_on_complete=true
)
```

### Continue an existing OpenCode session

```text
terminal(
  command="\"$RUNNER\" --root /home/jone/project --instructions .hermes/tasks/followup.md --session ses_abc123 --model opencode-go/deepseek-v4.1-flash",
  workdir="/home/jone/project",
  background=true,
  notify_on_complete=true
)
```

### Validate before spending tokens

```bash
"$RUNNER" --root /home/jone/project --instructions .hermes/tasks/review.md \
  --model review --dry-run
```

### Machine-readable monitoring

```bash
"$RUNNER" ... --jsonl > run.jsonl 2> run.err
```

`run.jsonl` contains `run.started`, `run.session`, raw `session.*` events, and a final
`run.finished` object.

## Result Contract

`result.json` includes:

| Field | Meaning |
|---|---|
| `ok` | `true` only when the session outcome is `succeeded` and no runner/terminal error exists. |
| `outcome` | `succeeded`, `failed`, `interrupted`, or `unknown`. |
| `text` | Final assistant text (what to show the user). |
| `reasoning` | Full reasoning trace, if the model produced one. |
| `tools` | Tool calls with name, status, redacted input, and error. |
| `permissions` | Permission prompts and the runner's decisions. |
| `error` / `terminal` | Failure detail when `ok=false`. |
| `session` | OpenCode session id, title, model, cost, tokens, timing. |
| `usage` | Session and last-message cost/token snapshots. |
| `harness` | Detected `AGENTS.md` / `opencode.json(c)` / `.opencode/`. |
| `artifacts` | Paths to `result.json`, `events.jsonl`, `run.log`, `meta.json`. |
| `instructions` | Relative path, byte count, SHA-256. |

Run directory layout:

```text
<run_dir>/
├── meta.json       # plan, root, instructions, pid, argv
├── events.jsonl    # app + raw OpenCode events (one JSON object per line)
├── run.log         # human-readable mirror of stdout
└── result.json     # final machine-readable result
```

See `references/result-schema.md` for the full field/event reference.

## Failure Handling

| Symptom | Action |
|---|---|
| `no running OpenCode server found` | `opencode service status`; start with `opencode service start`; or pass `--server`. |
| `model not found` | Run `opencode models`; use an exact `provider/model` or an alias from `config.json`. |
| `variant ... is not available` | Omit `#variant`/`--variant` or use one listed in the error. |
| `instructions file escapes the root` | Move the brief inside `--root`; symlinks are resolved and rejected. |
| `permission reject` in log/result | The run was non-interactive. Rerun with `--auto` **only for a trusted harness**, or add explicit `permissions` in config/harness. |
| `outcome: interrupted` / timeout | Inspect `result.json` and `events.jsonl`; rerun with a larger `--timeout` or split the task. |
| Process killed | Check `result.json`; if absent, inspect `events.jsonl` and `run.log`. |
| Harness not applied | Confirm `AGENTS.md` / `opencode.json(c)` are in `--root`; the session location is root. |
| Wrong process/session id | `RUN_DIR` is the artifact path; `SESSION_ID` is OpenCode; `session_id` from `terminal` is Hermes. |

## Pitfalls

- **One writer per root.** Parallel editing sessions in the same directory collide. Use git
  worktrees for parallel implementation tasks.
- **`--auto` is not a sandbox bypass.** It appends an allow-all rule after configured rules;
  never use it on an untrusted repo. Prefer explicit `permissions` for known needs.
- **The runner does not install/auth OpenCode.** That is deliberate; the server is already
  running and authenticated.
- **Do not use `process(action="submit")`.** The runner takes no stdin (except `--instructions -`).
  Cancel with `process(action="kill")`.
- **Do not put secrets in the instructions file.** OpenCode may echo prompt fragments in
  reasoning/events. Pass secrets through the harness/environment instead.
- **Do not claim success from the log alone.** Read `result.json`; `ok=false` can still have
  partial text.
- **Resume needs the matching root.** `--session` uses the existing session's location; pass
  the same `--root` it was created with.
- **Long reasoning is noisy.** Use `--no-reasoning` or `--quiet` when the log is being
  relayed to a chat.
- **Client/server generation drift.** `@opencode/client` is pinned in the plugin's
  `package.json`. If the OpenCode server is upgraded across a major/minor, install the
  matching client (`npm install @opencode/client@<server-version>`) and re-run `--dry-run`.

## Verification

```bash
"$RUNNER" --version
"$RUNNER" --root <ROOT> --instructions <FILE> --dry-run
```

Smoke test (free model, no repo changes):

```bash
printf 'Reply with exactly: OPENCODE_DELEGATE_OK. Do not use tools.\n' > <ROOT>/smoke.md
"$RUNNER" --root <ROOT> --instructions smoke.md \
  --model opencode/flint-40b-free --timeout 120 --heartbeat 0
```

Success: final block contains `OPENCODE_DELEGATE_OK`, `result.json` has `"ok": true`, and
the process exits `0`.

## Rules

1. Always dispatch delegated work with `background=true, notify_on_complete=true`.
2. Always read `result.json` before reporting success or failure.
3. Report `text`, `outcome`, `ok`, tools/tests, and remaining risks; summarize reasoning.
4. Never enable `--auto` on an untrusted harness.
5. Isolate parallel writers with worktrees; never share one root.
6. Keep the instructions file inside the root; do not leak secrets into it.
