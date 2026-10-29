---
name: opencode-delegate
description: "Dispatch one delegated task to the already-running OpenCode server through the bundled @opencode/client runner; stream reasoning/text and collect an sdw-run compatible result.json."
version: 1.1.0
author: Hermes Agent
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    tags: [OpenCode, delegation, background, node, opencode-client, harness, sdw-run, reasoning-stream]
    related_skills: [opencode, sdw-run, sdw-rules, coding-agent-delegation, hermes-agent]
---

# OpenCode Delegate

> When this skill is loaded, output "opencode-delegate loaded."

Dispatch **one** delegated task to a running OpenCode server via `@opencode/client` (`$HERMES_HOME/plugins/opencode-delegate/bin/opencode-delegate`). Creates or resumes a session at `--root`, submits a prompt file, streams events, and writes an `sdw-run`-compatible `result.json` (plus optional Step 4 `--evidence` or Step 5 `--verdict` artifacts).

> **Rules:** apply [`sdw-rules`](../../sdw-rules/SKILL.md) before running. Keep changes surgical, verify empirically, and never self-approve worker claims without checking `result.json` and the working tree.

## Dispatching Call & Contract

```bash
PLUGIN="${HERMES_HOME:-$HOME/.hermes}/plugins/opencode-delegate"
RUNNER="$PLUGIN/bin/opencode-delegate"

"$RUNNER" --root <DIR> --instructions <PROMPT_FILE> [options]
```

### Core & `sdw-run` Flags

| Flag / Alias | Env Fallback | Purpose |
|---|---|---|
| `-r, --root`, `-w, --working-dir`, `--workdir`, `--cwd` | `OPENCODE_DELEGATE_ROOT`, `SDW_WORKING_DIR`, `SDW_TARGET_ROOT` | Session location & harness root (`AGENTS.md`, `opencode.json(c)`, `.opencode/`). |
| `--target-root` | `SDW_TARGET_ROOT` (or inferred from `.sdw/worktrees/`) | Outer repository root when `--root` is a task worktree; allows prompts/evidence in `.sdw/state/`. |
| `-i, --instructions`, `-p, --prompt`, `--prompt-file` | `OPENCODE_DELEGATE_INSTRUCTIONS`, `SDW_PROMPT_FILE`, `SDW_JUDGE_PROMPT` | Prompt file inside `--root` or `--target-root` (or `-` for stdin). |
| `--evidence`, `--evidence-file` | `SDW_EVIDENCE_FILE` (or inferred from `task-<id>.prompt.md`) | `sdw-run` Step 4 task evidence JSON path; validated & normalized on exit. |
| `--verdict`, `--verdict-file` | `SDW_JUDGE_VERDICT` (or inferred from `step-5-judge.prompt.md`) | `sdw-run` Step 5 judge verdict JSON path; extracted from output if not written directly. |
| `--task, --task-id` / `--slug, --spec` / `--ac-ids` | `SDW_TASK_ID` / `SDW_SPEC_SLUG` / `SDW_AC_IDS` | SDW task metadata propagated into `result.json` and evidence validation. |
| `-m, --model` / `--provider` / `--variant` | `OPENCODE_DELEGATE_*`, `SDW_JUDGE_MODEL`, `SDW_JUDGE_PROVIDER`, `SDW_JUDGE_EFFORT` | Model alias (`fast`, `review`), `provider/model[#variant]`, or server default. |
| `-a, --agent` | `OPENCODE_DELEGATE_AGENT` | OpenCode agent (`build` for edits, `plan` for read-only review/judge). |
| `-t, --timeout` / `--heartbeat` / `--auto` / `--dry-run` | `OPENCODE_DELEGATE_TIMEOUT`, `OPENCODE_DELEGATE_AUTO_APPROVE` | Wall-clock deadline, heartbeat interval, trusted permission auto-approval, or preflight plan. |

### `sdw-run` Integration Modes

1. **Step 4 Subagent Mode (`sdw-run task next --json`)**:
   Pass the envelope paths directly—no `.hermes/tasks/` copy needed:
   ```bash
   "$RUNNER" --root "<workingDir>" --prompt-file "<promptFile>" --evidence "<evidenceFile>" --task "<taskId>" --slug "<specSlug>" --agent build
   ```
   The runner appends the SDW worker guardrail (write `<evidenceFile>` with `tests: [{name, status: "passed"|"failed"|"skipped", command?}]`; never run `task finish` or `git commit`). After exit `0`, the parent verifies `git status --porcelain`, re-runs tests, and submits `sdw_run.cjs task finish` (or `task abandon --reason` on failure).
2. **Step 4 Command Mode (`.sdw/config.json`)**:
   Set `"implementation": { "mode": "command", "command": "/path/to/opencode-delegate --auto" }` (reads `SDW_*` env vars automatically, including worktree containment via `SDW_TARGET_ROOT`).
3. **Step 5 Conformance Judge (`scoring.judgeCommand` or exit `5`)**:
   ```bash
   "$RUNNER" --root "<targetRoot>" --prompt-file "<judgePromptPath>" --verdict "<judgeVerdictPath>" --agent plan --model review
   ```
   Extracts `{ score, verdicts, notes }` into `<judgeVerdictPath>` and validates every criterion before exiting `0`.
4. **Ad-hoc Tasks & Step 7 Review / Fixer**:
   For custom tasks, write `<ROOT>/.hermes/tasks/<slug>.md` and pass `--instructions`. Use `--agent plan --model review` for `sdw-code-review` and `--agent build` for `sdw-fixer`.

## Execution & Monitoring

Early stdout prints `RUN_DIR=`, `RESULT_FILE=`, `SESSION_ID=`, and (when active) `EVIDENCE_FILE=` / `VERDICT_FILE=`.
- **Background handle (Hermes):** `terminal(command="...", workdir="<ROOT>", background=true, notify_on_complete=true)`, then `process(action="poll"|"log"|"kill", session_id="<HANDLE>")`.
- **Foreground / Subprocess (`sdw-run` command mode):** Run with `--timeout <seconds>` and `--quiet` or `--no-reasoning`.
- **Event stream:** Pass `--jsonl` or tail `<RUN_DIR>/events.jsonl`.

## Result Format (`result.json`)

| Field | Contract |
|---|---|
| `ok` | `true` only when `outcome === "succeeded"`, no runner error exists, and any active `--evidence` (`status: "success"`) or `--verdict` validates. |
| `status` | SDW-compatible status: `"success"`, `"partial"`, `"failed"`, or `"blocked"`. |
| `outcome` | OpenCode session outcome: `"succeeded"`, `"failed"`, `"interrupted"`, or `"unknown"`. |
| `taskId`, `specSlug`, `acIds` | SDW task identifier, specification slug, and satisfied acceptance criteria IDs (`string[]`). |
| `filesChanged` | Project-relative POSIX paths modified/created during the run (from validated evidence or git baseline diff). |
| `tests` | Normalized SDW test records: `[{ "name": string, "status": "passed"\|"failed"\|"skipped", "command"?: string }]`. |
| `summary` / `text` | Concise 1–2 sentence task summary (`summary`) and full final assistant message (`text`). |
| `evidence` / `verdict` | `{ path, relative, exists, valid, errors, data }` for Step 4 task evidence or Step 5 judge verdict (`null` when unused). |
| `tools`, `permissions`, `usage`, `artifacts` | Redacted tool calls, permission decisions, token/cost totals, and paths (`result`, `events`, `log`, `meta`, `evidence`, `verdict`). |

## Verification

```bash
"$RUNNER" --version
"$RUNNER" --root <ROOT> --prompt-file <FILE> --dry-run
```

## References

- Result schema, SDW evidence/verdict contracts, caller monitoring options, configuration, and failure handling: [`references/result-schema.md`](references/result-schema.md)
