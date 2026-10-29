# opencode-delegate result schema

Every run writes a directory:

```text
<run_dir>/
├── meta.json
├── events.jsonl
├── run.log
└── result.json
```

`result.json` is the authoritative outcome. `events.jsonl` is the raw trace and is useful
when the process was killed or `result.json` is missing.

## result.json

```json
{
  "ok": true,
  "dry_run": false,
  "run_id": "ocd_20261029T154225Z_12b87c",
  "outcome": "succeeded",
  "error": null,
  "terminal": {
    "kind": "session.execution.succeeded",
    "outcome": "succeeded",
    "reason": null
  },
  "text": "final assistant text",
  "reasoning": "full reasoning trace, if any",
  "tools": [
    {
      "id": "call_...",
      "name": "shell",
      "status": "completed",
      "input": { "command": "printf TOOL_OK" },
      "error": null
    }
  ],
  "permissions": [
    {
      "request_id": "per_...",
      "action": "shell",
      "resources": ["git status"],
      "decision": "reject",
      "at": "2026-10-29T15:43:50.639Z"
    }
  ],
  "run": {
    "started_at": "2026-10-29T15:42:25.701Z",
    "finished_at": "2026-10-29T15:42:28.332Z",
    "duration_ms": 2631
  },
  "root": "/path/to/harness",
  "instructions": {
    "relative": ".hermes/tasks/task.md",
    "path": "/path/to/harness/.hermes/tasks/task.md",
    "bytes": 123,
    "sha256": "..."
  },
  "harness": {
    "root": "/path/to/harness",
    "files": ["AGENTS.md", "opencode.jsonc", ".opencode"],
    "has_agents_md": true,
    "has_opencode_config": true,
    "has_opencode_dir": true
  },
  "server": {
    "url": "http://127.0.0.1:49374",
    "source": "service",
    "version": "2.2.1",
    "pid": 3016
  },
  "model": {
    "providerID": "opencode-go",
    "id": "deepseek-v4.1-flash",
    "variant": null,
    "name": "DeepSeek V4.1 Flash"
  },
  "agent": "build",
  "session": {
    "id": "ses_...",
    "resumed": false,
    "title": "Hermes delegated task — task.md",
    "outcome": "succeeded",
    "location": { "directory": "/path/to/harness" },
    "cost": 0,
    "tokens": { "input": 6675, "output": 41, "reasoning": 0, "cache": { "read": 256, "write": 0 } },
    "model": { "id": "deepseek-v4.1-flash", "providerID": "opencode-go", "variant": "default" },
    "time": { "created": 1793288545824, "updated": 1793288548297, "idle": 1793288548301 }
  },
  "usage": {
    "session": { "cost": 0, "tokens": { "input": 6675, "output": 41 } },
    "last_message": { "cost": 0, "tokens": { "input": 6675, "output": 41 }, "finish": "stop" }
  },
  "counts": {
    "assistant_messages": 1,
    "tool_calls": 0,
    "tools_failed": 0
  },
  "artifacts": {
    "run_dir": "/.../runs/ocd_...",
    "result": "/.../runs/ocd_.../result.json",
    "events": "/.../runs/ocd_.../events.jsonl",
    "log": "/.../runs/ocd_.../run.log",
    "meta": "/.../runs/ocd_.../meta.json"
  },
  "config_file": "/.../plugins/opencode-delegate/config.json"
}
```

### Field notes

- `ok` — true only when `outcome === "succeeded"` and no runner/terminal error is present.
- `outcome` — `succeeded`, `failed`, `interrupted`, or `unknown`.
- `error` — human-readable failure detail; null on success.
- `terminal.kind` — `session.execution.succeeded`, `session.execution.failed`,
  `session.execution.interrupted`, `session.idle`, `timeout`, `signal`, `prompt.error`,
  `runner.error`, or `stream-ended`.
- `text` — text from the last assistant message that contains text. This is the user-facing
  answer.
- `reasoning` — concatenated reasoning blocks across assistant messages.
- `tools` — one entry per assistant tool block; `input` is secret-redacted and truncated.
- `permissions` — every permission prompt the runner answered. A `reject` means the runner
  was non-interactive; rerun with `--auto` only for trusted harnesses.
- `session.cost` / `session.tokens` — authoritative session totals when the server returns
  them.
- `artifacts` — paths inside the run directory. Use `result.artifacts.result` if the run
  directory was overridden.

## Dry run

`--dry-run` writes a result with `"dry_run": true`, `"ok": true`, and a `model`/`server`/
`harness` plan. No OpenCode session is created and no prompt is sent.

## events.jsonl

One JSON object per line:

```json
{"ts":"2026-10-29T15:42:37.908Z","type":"session.execution.started","data":{"sessionID":"ses_..."}}
```

App events use the `run.*` prefix (`run.started`, `run.server`, `run.session`, `run.prompt`,
`run.heartbeat`, `run.finished`, `run.dry_run`). OpenCode events keep their native names
(`session.reasoning.delta`, `session.tool.called`, `permission.asked`, ...). Large string
fields are truncated at ~4 KB, and tool permission input is not included wholesale.

## run.log

A human-readable mirror of stdout: lifecycle lines, streamed reasoning, streamed output,
tool markers, permission decisions, and the final `=== RESULT ===` block. Useful when the
process was killed before `result.json` was written.

## meta.json

Written at start: run id, pid, cwd, node version, argv, root, instructions, harness, and the
config file path. It does not contain server headers or credentials.
