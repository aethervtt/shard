import { ShardError } from '@shard/core'

/** Exit codes: stable, documented, and what scripts and agents branch on. */
export const EXIT = { ok: 0, failed: 1, runtime: 2, usage: 3 } as const

export interface Output {
  json: boolean
  /** Human-readable progress and results, to stderr (stdout stays clean for data). */
  say(message: string): void
  /** The command's result: one JSON document on stdout with --json, a summary on stderr otherwise. */
  result(data: unknown, summary?: string): void
}

export function createOutput(json: boolean): Output {
  return {
    json,
    say: (message) => process.stderr.write(`${message}\n`),
    result(data, summary) {
      if (json) process.stdout.write(`${JSON.stringify(data, null, 2)}\n`)
      else process.stderr.write(`${summary ?? JSON.stringify(data, null, 2)}\n`)
    },
  }
}

/** Formats an error for humans: code, message, where, and what to do. */
export function formatError(error: unknown): string {
  if (!(error instanceof ShardError))
    return error instanceof Error ? (error.stack ?? error.message) : String(error)
  const lines = [`error[${error.code}]: ${error.message}`]
  if (error.path) lines.push(`  at ${error.path}`)
  if (error.hint) lines.push(`  hint: ${error.hint}`)
  for (const d of error.details?.slice(1) ?? [])
    lines.push(`  also [${d.code}] ${d.path ?? ''}: ${d.message}`)
  return lines.join('\n')
}

export function errorJson(error: unknown) {
  return error instanceof ShardError
    ? error.toJSON()
    : { code: 'cli/unexpected', message: error instanceof Error ? error.message : String(error) }
}
