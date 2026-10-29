import fs from "node:fs"
import path from "node:path"

function iso() {
  return new Date().toISOString()
}

/**
 * Writes four artifacts in the run directory:
 *   run.log       human-readable mirror of stdout
 *   events.jsonl  every app/API event as one JSON object per line
 *
 * In JSON mode stdout is NDJSON too; in text mode stdout is readable progress plus
 * the streamed reasoning/output.
 */
export class RunOutput {
  constructor({ runDir, json = false, quiet = false, reasoning = true }) {
    this.runDir = runDir
    this.json = json
    this.quiet = quiet
    this.reasoning = reasoning
    this.logStream = null
    this.eventStream = null
    this.closed = false
  }

  init() {
    fs.mkdirSync(this.runDir, { recursive: true })
    this.logStream = fs.createWriteStream(path.join(this.runDir, "run.log"), { flags: "a" })
    this.eventStream = fs.createWriteStream(path.join(this.runDir, "events.jsonl"), { flags: "a" })
  }

  _write(stream, text) {
    if (stream && !this.closed) stream.write(text)
  }

  plain(line) {
    this._write(this.logStream, `${line}\n`)
    if (!this.json) process.stdout.write(`${line}\n`)
  }

  log(message) {
    this.plain(`[opencode-delegate] ${message}`)
  }

  warn(message) {
    this.log(`WARN ${message}`)
  }

  section(name) {
    if (this.json || this.quiet) return
    this._write(this.logStream, `\n--- ${name} ---\n`)
    process.stdout.write(`\n--- ${name} ---\n`)
  }

  /** Streamed model text. */
  text(delta) {
    if (!delta) return
    this._write(this.logStream, delta)
    if (!this.json && !this.quiet) process.stdout.write(delta)
  }

  /** Streamed reasoning text. */
  reasoningDelta(delta) {
    if (!delta || !this.reasoning) return
    this._write(this.logStream, delta)
    if (!this.json && !this.quiet) process.stdout.write(delta)
  }

  newline() {
    if (this.json || this.quiet) return
    this._write(this.logStream, "\n")
    process.stdout.write("\n")
  }

  /** Append one event to events.jsonl and echo it as NDJSON in JSON mode. */
  record(type, data) {
    const line = `${JSON.stringify({ ts: iso(), type, data })}\n`
    this._write(this.eventStream, line)
    if (this.json) process.stdout.write(line)
  }

  finalText(text) {
    if (!text) return
    if (!this.json) {
      this._write(this.logStream, `\n=== RESULT ===\n${text}\n=== END RESULT ===\n`)
      process.stdout.write(`\n=== RESULT ===\n${text}\n=== END RESULT ===\n`)
    }
  }

  async close() {
    if (this.closed) return
    this.closed = true
    const waits = [this.logStream, this.eventStream]
      .filter(Boolean)
      .map(
        (stream) =>
          new Promise((resolve) => {
            stream.end(resolve)
          }),
      )
    await Promise.all(waits)
  }
}
