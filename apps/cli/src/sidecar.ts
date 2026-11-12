/**
 * Compiling a game server into one executable with Bun (0111): `shard export --target server
 * --compile`, and the desktop shells' `--sidecar`. The executable needs nothing installed; it
 * reads the export's data from `SHARD_DIR` (or beside itself) under the launch contract.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ShardError } from '@aethervtt/shard-core'

const script = resolve(dirname(fileURLToPath(import.meta.url)), '../bun/compile.mjs')

/** This machine's target triple: what Tauri names sidecars by (`rustc -vV`), or the usual one. */
export function hostTriple(): string {
  try {
    const host = /^host: (.+)$/m.exec(execFileSync('rustc', ['-vV'], { encoding: 'utf8' }))?.[1]
    if (host) return host.trim()
  } catch {}
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
  if (process.platform === 'darwin') return `${arch}-apple-darwin`
  if (process.platform === 'win32') return `${arch}-pc-windows-msvc`
  return `${arch}-unknown-linux-gnu`
}

/** Bun's compile target for a triple: `aarch64-apple-darwin` is `bun-darwin-arm64`. */
export function bunTarget(triple: string): string {
  const arch = triple.startsWith('aarch64') ? 'arm64' : 'x64'
  const os = triple.includes('apple') ? 'darwin' : triple.includes('windows') ? 'windows' : 'linux'
  return `bun-${os}-${arch}`
}

/**
 * Compiles `entry` (a server export's `server.mjs`, or a project's own server source) into
 * `outfile` for `triple`. Fails with `export/missing-tool` without Bun on the path.
 */
export function compileServer(options: { entry: string; outfile: string; triple?: string }): {
  file: string
  bytes: number
  triple: string
} {
  const triple = options.triple ?? hostTriple()
  const file = triple.includes('windows') ? `${options.outfile}.exe` : options.outfile
  const run = spawnSync('bun', [script, resolve(options.entry), file, bunTarget(triple)], {
    encoding: 'utf8',
  })
  if (run.error) {
    throw new ShardError('export/missing-tool', 'Compiling a server needs Bun on the path', {
      hint: 'Install Bun (https://bun.sh), or export without --compile/--sidecar.',
    })
  }
  if (run.status !== 0) {
    throw new ShardError('export/compile-failed', `Bun couldn't compile ${options.entry}`, {
      path: options.entry,
      hint: run.stderr.trim().split('\n').slice(0, 5).join('\n'),
    })
  }
  return { file, bytes: statSync(file).size, triple }
}
