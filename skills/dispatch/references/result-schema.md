# opencode-delegate Dispatch Contract & Result Schema

Every run writes a directory:

```text
<run_dir>/
├── meta.json
├── events.jsonl
├── run.log
└── result.json
```

`result.json` is the authoritative outcome. When `--evidence` (or `SDW_EVIDENCE_FILE` / `task-<id>.prompt.md`) or `--verdict` (or `SDW_JUDGE_VERDICT` / `step-5-judge.prompt.md`) is active, the runner also validates and writes the SDW evidence or judge verdict JSON file before exiting.

The runner's contract is the run directory (plus any SDW evidence/verdict file) and the exit code. How a caller watches a run while it is in flight is the caller's choice; see [Consuming a run](#consuming-a-run-caller-options).

## Dispatching Call & SDW Contract

### CLI Flags & Environment Fallbacks

| Flag / Alias | Environment Fallback | Description |
|---|---|---|
| `-r, --root`, `-w, --working-dir`, `--workdir`, `--cwd` | `OPENCODE_DELEGATE_ROOT`, `SDW_WORKING_DIR`, `SDW_TARGET_ROOT` | Harness/runtime root and OpenCode session location. Required. |
| `--target-root` | `SDW_TARGET_ROOT` (or auto-inferred from `.sdw/worktrees/`) | Outer project root when `--root` is an isolated git worktree; permits `--instructions`, `--evidence`, and `--verdict` inside `<target-root>/.sdw/state/`. |
| `-i, --instructions`, `-p, --prompt`, `--prompt-file` | `OPENCODE_DELEGATE_INSTRUCTIONS`, `SDW_PROMPT_FILE`, `SDW_JUDGE_PROMPT` | Task or judge prompt file (must resolve inside `--root` or `--target-root`, or `-` for stdin). Required. |
| `--evidence`, `--evidence-file` | `SDW_EVIDENCE_FILE` (or inferred from `task-<id>.prompt.md`) | `sdw-run` Step 4 task evidence JSON path. |
| `--verdict`, `--verdict-file` | `SDW_JUDGE_VERDICT` (or inferred from `step-5-judge.prompt.md`) | `sdw-run` Step 5 judge verdict JSON path. |
| `--diff-file` / `--criteria-file` | `SDW_JUDGE_DIFF` / `SDW_JUDGE_CRITERIA` | Optional Step 5 diff and criteria artifact paths. |
| `--task, --task-id` | `SDW_TASK_ID` (or inferred from prompt) | SDW DAG task identifier (`task-1`, `task-refine`, etc.). |
| `--slug, --spec` | `SDW_SPEC_SLUG` (or inferred from prompt) | SDW specification slug. |
| `--run-id` | `SDW_RUN_ID` (or inferred from prompt) | SDW orchestrator run identifier. |
| `--ac-ids` | `SDW_AC_IDS` (or inferred from prompt) | Comma-separated acceptance criteria IDs (`AC1,AC2`). |
| `-s, --server` | `OPENCODE_SERVER_URL`, `SDW_JUDGE_API_ENDPOINT` | Explicit OpenCode server URL (empty discovers registered local service). |
| `--auto-start` | `config.server.auto_start` | Start the registered local OpenCode service if none is running. |
| `-c, --config` / `--env-file` | `OPENCODE_DELEGATE_CONFIG` / `OPENCODE_DELEGATE_ENV` | Alternate `config.json` or `.env` path. |
| `-m, --model` | `OPENCODE_DELEGATE_MODEL`, `SDW_JUDGE_MODEL` | Model alias (`fast`, `review`), `provider/model[#variant]`, or bare model id. |
| `--provider` | `OPENCODE_DELEGATE_PROVIDER`, `SDW_JUDGE_PROVIDER` | Provider paired with a bare model id. |
| `--variant` | `OPENCODE_DELEGATE_VARIANT`, `SDW_JUDGE_EFFORT` | Model variant / reasoning effort (`high`, `max`). |
| `-a, --agent` | `OPENCODE_DELEGATE_AGENT` | OpenCode agent id (`build`, `plan`). |
| `--title` / `--session` | — | Session title or existing OpenCode `ses_...` ID to resume. |
| `-t, --timeout` / `--heartbeat` | `OPENCODE_DELEGATE_TIMEOUT` | Wall-clock timeout seconds (default 3600) and heartbeat seconds (default 30). |
| `--run-dir` / `--result` | `OPENCODE_DELEGATE_RUN_DIR` | Parent directory for run artifacts or explicit `result.json` path. |
| `--auto` | `OPENCODE_DELEGATE_AUTO_APPROVE` | Auto-approve permission prompts (trusted harnesses only). |
| `--no-reasoning` / `-q, --quiet` | `OPENCODE_DELEGATE_REASONING` | Suppress reasoning deltas or all streaming progress. |
| `--json, --jsonl` | — | Emit newline-delimited JSON events on stdout. |
| `--dry-run` / `--print-config` | — | Validate server/model/paths without creating a session, or print resolved config. |

### `sdw-run` Integration Recipes

1. **Step 4 — Subagent Dispatch (`implementation.mode: "subagent"`)**
   When `sdw_run.cjs run <spec>` or `sdw_run.cjs task next --run-id <runId> --json` pauses with exit `4` and emits an envelope:
   ```bash
   "$RUNNER" \
     --root "<envelope.workingDir>" \
     --prompt-file "<envelope.promptFile>" \
     --evidence "<envelope.evidenceFile>" \
     --task "<envelope.taskId>" \
     --slug "<envelope.specSlug>" \
     --agent build
   ```
   - When `--prompt-file` points to `.sdw/state/<slug>/<runId>/task-<id>.prompt.md`, `--evidence`, `--task`, `--slug`, and `--run-id` are inferred automatically even if omitted.
   - The runner appends a worker contract reminder so the OpenCode session writes `<evidenceFile>` with `tests: [{"name": "...", "status": "passed"|"failed"|"skipped", "command": "..."}]` and stops without running `sdw_run.cjs task finish` or `git commit`.
   - When the runner exits `0` (`result.ok === true` and `result.status === "success"`), the parent runs the `sdw-run` accept checklist (`git status --porcelain`, test verification) and executes `envelope.finishCommand`. On failure, run `sdw_run.cjs task abandon --run-id <runId> --task <taskId> --reason "<result.error>"`.

2. **Step 4 — Command Mode (`implementation.mode: "command"`)**
   In `.sdw/config.json`:
   ```json
   {
     "implementation": {
       "mode": "command",
       "command": "/home/jone/.hermes/plugins/opencode-delegate/bin/opencode-delegate --auto"
     }
   }
   ```
   Or with explicit tokens:
   ```json
   {
     "implementation": {
       "mode": "command",
       "command": "/home/jone/.hermes/plugins/opencode-delegate/bin/opencode-delegate --working-dir {workingDir} --target-root {targetRoot} --prompt-file {promptFile} --evidence {evidenceFile} --task {taskId} --slug {slug} --auto"
     }
   }
   ```
   When `useWorktrees: true`, `--working-dir` is `.sdw/worktrees/<runId>/<taskId>` while `--prompt-file` and `--evidence` live in `<targetRoot>/.sdw/state/<slug>/<runId>/`. `--target-root` (or `SDW_TARGET_ROOT` / worktree auto-detection) keeps containment checks intact across both directories.

3. **Step 5 — LLM Conformance Judge (`scoring.judgeCommand` or exit `5`)**
   In `.sdw/config.json`:
   ```json
   {
     "scoring": {
       "judgeCommand": "/home/jone/.hermes/plugins/opencode-delegate/bin/opencode-delegate --agent plan --model review"
     }
   }
   ```
   Or when Step 5 pauses with exit `5`:
   ```bash
   "$RUNNER" --root <ROOT> --prompt-file .sdw/state/<slug>/<runId>/step-5-judge.prompt.md --agent plan --model review
   node skills/sdw-run/scripts/sdw_run.cjs score submit --run-id <runId> --verdict .sdw/state/<slug>/<runId>/step-5-judge.verdict.json
   ```

## result.json

```json
{
  "ok": true,
  "dry_run": false,
  "run_id": "ocd_20261029T154225Z_12b87c",
  "status": "success",
  "outcome": "succeeded",
  "error": null,
  "taskId": "task-1",
  "specSlug": "00042-auth-retry",
  "acIds": ["AC1", "AC2"],
  "filesChanged": ["src/auth/client.ts", "test/auth.test.ts"],
  "tests": [
    {
      "name": "auth retry suite",
      "command": "npm test -- auth",
      "status": "passed"
    }
  ],
  "summary": "Added retry-with-backoff for 429 and 5xx responses and unit tests.",
  "evidence": {
    "path": "/path/to/harness/.sdw/state/00042-auth-retry/run-123/task-1.evidence.json",
    "relative": ".sdw/state/00042-auth-retry/run-123/task-1.evidence.json",
    "exists": true,
    "valid": true,
    "repaired": false,
    "status": "success",
    "errors": [],
    "data": {
      "taskId": "task-1",
      "status": "success",
      "acIds": ["AC1", "AC2"],
      "filesChanged": ["src/auth/client.ts", "test/auth.test.ts"],
      "tests": [
        {
          "name": "auth retry suite",
          "command": "npm test -- auth",
          "status": "passed"
        }
      ],
      "summary": "Added retry-with-backoff for 429 and 5xx responses and unit tests."
    }
  },
  "verdict": null,
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
      "input": { "command": "npm test -- auth" },
      "error": null
    }
  ],
  "permissions": [],
  "run": {
    "started_at": "2026-10-29T15:42:25.701Z",
    "finished_at": "2026-10-29T15:42:28.332Z",
    "duration_ms": 2631
  },
  "root": "/path/to/harness",
  "target_root": "/path/to/harness",
  "instructions": {
    "relative": ".sdw/state/00042-auth-retry/run-123/task-1.prompt.md",
    "path": "/path/to/harness/.sdw/state/00042-auth-retry/run-123/task-1.prompt.md",
    "bytes": 1840,
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
    "title": "Hermes delegated task — .sdw/state/00042-auth-retry/run-123/task-1.prompt.md",
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
    "tool_calls": 1,
    "tools_failed": 0
  },
  "artifacts": {
    "run_dir": "/.../runs/ocd_...",
    "result": "/.../runs/ocd_.../result.json",
    "events": "/.../runs/ocd_.../events.jsonl",
    "log": "/.../runs/ocd_.../run.log",
    "meta": "/.../runs/ocd_.../meta.json",
    "evidence": "/path/to/harness/.sdw/state/00042-auth-retry/run-123/task-1.evidence.json"
  },
  "config_file": "/.../plugins/opencode-delegate/config.json"
}
```

### Field notes

- `ok` — `true` only when `outcome === "succeeded"`, no runner/terminal error is present, and any active SDW `--evidence` (`status === "success"` and schema-valid) or `--verdict` (schema-valid) succeeded.
- `status` — SDW-compatible status (`"success"`, `"partial"`, `"failed"`, or `"blocked"`).
- `outcome` — OpenCode session outcome (`"succeeded"`, `"failed"`, `"interrupted"`, or `"unknown"`).
- `taskId`, `specSlug`, `acIds` — SDW task metadata (from flags, `SDW_*` env vars, prompt header, or evidence file).
- `filesChanged` — project-relative POSIX file paths modified/created during the run (from validated evidence, or detected against the pre-run git baseline in `--root`).
- `tests` — array of `{ "name": string, "status": "passed" | "failed" | "skipped", "command"?: string }`. When a worker writes `{ command, result }`, the runner normalizes it to `{ name, status, command }` before `evidence_validator.cjs` runs.
- `summary` — concise summary from `evidence.data.summary`, `verdict.data.notes`, or the first paragraph of `text`.
- `evidence` — present when `--evidence`, `SDW_EVIDENCE_FILE`, or `task-<id>.prompt.md` is used. Contains `{ path, relative, exists, valid, repaired, status, errors, data }`.
- `verdict` — present when `--verdict`, `SDW_JUDGE_VERDICT`, or `step-5-judge.prompt.md` is used. Contains `{ path, relative, exists, valid, extracted, score, errors, data }`.
- `error` — human-readable failure detail; `null` on success.
- `terminal.kind` — `session.execution.succeeded`, `session.execution.failed`, `session.execution.interrupted`, `session.idle`, `timeout`, `signal`, `prompt.error`, `runner.error`, or `stream-ended`.
- `text` — text from the last assistant message that contains text.
- `reasoning` — concatenated reasoning blocks across assistant messages.
- `tools` — one entry per assistant tool block; `input` is secret-redacted and truncated.
- `permissions` — every permission prompt the runner answered. A `reject` means the runner was non-interactive; rerun with `--auto` only for trusted harnesses.
- `session.cost` / `session.tokens` — authoritative session totals when the server returns them.
- `artifacts` — paths inside the run directory, plus `evidence` / `verdict` when active.

## Dry run

`--dry-run` writes a result with `"dry_run": true`, `"ok": true`, `"status": "success"`, resolved SDW metadata (`taskId`, `specSlug`, `acIds`, `evidence_file`, `verdict_file`), and a `model`/`server`/`harness` plan. No OpenCode session is created and no prompt is sent.

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

Written at start: run id, pid, cwd, node version, argv, root, target_root, SDW metadata, instructions, harness, and the config file path. It does not contain server headers or credentials.

## Consuming a run (caller options)

This section is advisory. The runner does not require any particular monitoring strategy and
does not know which harness invoked it. Pick whatever your runtime supports; all of the
options below observe the same run and end with the same `result.json`, so switching between
them changes only your visibility, never the outcome.

What the runner exposes while a run is in flight:

| Signal | Stability | Use it for |
|---|---|---|
| Exit code | contract | pass/fail at the process level (`0` success, `1` task/session/evidence failure, `2` usage error) |
| stdout, default mode | human-facing | `[opencode-delegate] ...` lifecycle, reasoning, tool and result lines |
| stdout, `--jsonl` | structured | machine parsing: one JSON event per line, same shape as `events.jsonl` |
| `events.jsonl` | structured, append-only | polling a run you did not start in this process |
| `run.log` | human-facing, append-only | post-mortem when the process died before `result.json` |
| `result.json` | contract | the authoritative terminal outcome |
| `meta.json` | contract at start | run id, pid, root, argv, config path |

### If your harness can background a process and hand you a handle

Recommended for long runs. Start the runner detached, keep the handle, and then either wait
or watch:

- **Wait for completion.** Block on the process and read `result.json` afterwards. Simplest,
  always correct, no partial visibility.
- **Poll the handle.** Ask the runtime for output accumulated so far (a snapshot) or output
  since the last read (a delta). Reporting each delta gives chunked, near-real-time progress;
  granularity equals your poll interval, not the model's token rate.
- **Tail `events.jsonl`.** Works even if the process was started by something else, and does
  not depend on your runtime's process API. Filter on `type` to keep it scannable, for example
  only `session.text.delta`, `session.tool.called`, `session.tool.success`,
  `session.step.ended`, `run.finished`.
- **React on patterns.** If your runtime supports matching output lines and waking the
  caller, trigger on terminal events (`run.finished`, `session.execution.succeeded`,
  `session.execution.failed`, `permission.asked`) instead of polling blindly.

Examples of that capability, in different ecosystems: a supervisor with session handles and
output buffers, `tmux`/`screen` panes, `systemd-run --user --pty` plus `journalctl -f`,
`nohup ... &` plus `tail -f run.log`, or an orchestrator that reaps child processes.

### If your harness only runs foreground commands

- Bound the wait with `--timeout` (seconds) and let the run finish or be killed.
- Prefer `--quiet`, or `--no-reasoning`, so the foreground output stays small.
- Accept that a foreground call returns nothing until the process ends. If partial progress
  matters, have another process tail `events.jsonl` while it runs.

### If your harness spawns a child agent instead of a process

- A child agent typically reports only when it finishes, so you get the same visibility as
  "wait for completion" and none of the intermediate detail.
- If the child keeps a readable transcript, point it at `run.log` or `events.jsonl` so the
  parent can inspect progress mid-flight.
- Spawn children per independent task, not per run you want to watch closely.

### Level of detail

- `--jsonl` (`--json`) for structured events; default mode for a human reading the terminal.
- `--quiet` suppresses reasoning/text/tool progress and leaves the `=== RESULT ===` block.
- `--no-reasoning` keeps text and tools but drops reasoning deltas.
- `--heartbeat <seconds>` bounds silence: the runner emits `run.heartbeat` while it waits
  (`0` disables). Useful for liveness checks on long sessions.
- `--dry-run` resolves server, harness, model and permissions without creating a session,
  so it is the cheap pre-flight before any monitoring strategy matters.

### Pitfalls & Failure Handling

- **One writer per root.** Parallel editing sessions in the same directory collide. Use git worktrees (`--working-dir <worktree> --target-root <repo>`) for parallel tasks.
- **SDW Step 4 ownership.** Never let the delegated worker run `sdw_run.cjs task finish` or `git commit`; the worker writes the evidence JSON and stops, and the parent runs `task finish` after verifying the working tree.
- **Do not parse `run.log`.** Parse `events.jsonl` or `result.json`.
- **Do not read `result.json` while the run is in flight and treat it as final.** Wait for process exit or `run.finished`.
- **`permissions[].decision === "reject"`.** The run was non-interactive and a prompt was auto-rejected. Fix with permission rules in the harness, or `--auto` on trusted harnesses.
