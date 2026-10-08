// shard profile (0074): a capture of a scene headless, or of an attached app, printed as its
// summary; and `--cpu-prof` for `shard run`, `shard profile` and `shard test`.

import { mkdir, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { type CaptureSummary, ShardError } from '@aethervtt/shard-core'
import { hottestFromCpuProfile } from '@aethervtt/shard-core/capture'
import { openProject } from '@aethervtt/shard-node'
import { createNodePerformance } from '@aethervtt/shard-platform-node'
import { DEFAULT_HUB_PORT } from '@aethervtt/shard-protocol'
import { captureStamp } from '@aethervtt/shard-runtime'
import { loadScene } from '@aethervtt/shard-scene'
import type { CommandContext } from './commands'
import { Hub, localTarget, type ProtocolTarget } from './hub'
import { EXIT } from './output'

/** Where captures, traces and profiles go, project-relative (0074). */
export const CAPTURES_DIR = '.shard/captures'
/** How long `shard profile --attach` waits for an app to dial in. */
const ATTACH_WAIT_MS = 60_000

function numberFlag(value: unknown, fallback: number): number {
  if (value === undefined) return fallback
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) {
    throw new ShardError('cli/usage', `Expected a number, got "${String(value)}"`)
  }
  return n
}

export interface CaptureResponse {
  summary: CaptureSummary
  tracePath?: string
  profilePath?: string
  trace?: unknown
}

const ms = (v: number) => `${v.toFixed(2)} ms`

/** The summary for humans: frames, top spans, the worst frames and what grew in them. */
export function formatSummary(result: CaptureResponse): string {
  const s = result.summary
  const lines = [
    `${s.frames.count} frames: CPU p50 ${ms(s.frames.cpu.p50)}, p95 ${ms(s.frames.cpu.p95)}, max ${ms(s.frames.cpu.max)}` +
      (s.frames.gpu ? `; GPU p95 ${ms(s.frames.gpu.p95)}` : ''),
  ]
  if (s.capture.trigger) {
    lines.push(`Slow frame ${s.capture.trigger.frame}: ${ms(s.capture.trigger.frameMs)}`)
  }
  lines.push('', 'Top spans (total, per-frame p95):')
  for (const t of s.top.slice(0, 10)) {
    lines.push(
      `  ${t.span.padEnd(36)} ${ms(t.total).padStart(12)} ${ms(t.p95).padStart(10)}  ${t.track}`,
    )
  }
  lines.push('', 'Worst frames:')
  for (const w of s.worst) {
    const over = w.over.map((o) => `${o.span} ${ms(o.ms)} (median ${ms(o.medianMs)})`).join('; ')
    lines.push(`  frame ${w.frame}: ${ms(w.cpuMs)}${over ? ` — ${over}` : ''}`)
  }
  if (s.hottest?.length) {
    lines.push('', 'Hottest functions (self time):')
    for (const f of s.hottest.slice(0, 5)) {
      lines.push(`  ${f.name}${f.url ? ` ${f.url}:${f.line ?? '?'}` : ''}  ${ms(f.selfMs)}`)
    }
  }
  for (const w of s.warnings) lines.push(`warning[${w.code}]: ${w.message}`)
  if (result.tracePath)
    lines.push('', `Trace: ${result.tracePath} (open in https://ui.perfetto.dev)`)
  if (result.profilePath) lines.push(`CPU profile: ${result.profilePath}`)
  return lines.join('\n')
}

/** Waits for an app to attach to the hub. */
async function attached(hub: Hub): Promise<ProtocolTarget> {
  const now = hub.current()
  if (now) return now
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off()
      reject(
        new ShardError('cli/no-target', 'No app attached to the hub', {
          hint: 'Start the app (shard dev, Studio) with the hub address, then run this again.',
        }),
      )
    }, ATTACH_WAIT_MS)
    const off = hub.onAttach(() => {
      const target = hub.current()
      if (!target) return
      clearTimeout(timer)
      off()
      resolve(target)
    })
  })
}

export async function profile(ctx: CommandContext): Promise<number> {
  const frames = numberFlag(ctx.flags.frames, 600)
  const untilMs = ctx.flags['until-ms'] === undefined ? 0 : numberFlag(ctx.flags['until-ms'], 50)
  const params = {
    frames,
    ...(untilMs > 0 ? { until: { frameMs: untilMs } } : {}),
    sample: Boolean(ctx.flags['cpu-prof']),
  }
  const scene = (ctx.args[0] ?? ctx.flags.scene) as string | undefined
  let result: CaptureResponse
  if (ctx.flags.attach) {
    const hub = new Hub()
    const port = await hub.start(
      numberFlag(ctx.flags.port ?? process.env.SHARD_HUB_PORT, DEFAULT_HUB_PORT),
    )
    ctx.out.say(`Waiting for an app on ws://127.0.0.1:${port}…`)
    try {
      const target = await attached(hub)
      ctx.out.say(`Capturing ${target.name}…`)
      result = await target.request<CaptureResponse>('perf.capture', params)
    } finally {
      hub.close()
    }
  } else {
    const p = await openProject({ root: ctx.project, loadStartScene: !scene })
    try {
      if (scene) {
        loadScene(p.app.world, JSON.parse(await p.platform.fs.readText(scene)), { id: scene })
      }
      result = await localTarget('headless', p.server).request<CaptureResponse>(
        'perf.capture',
        params,
      )
    } finally {
      p.close()
    }
  }
  const { trace: _, ...out } = result
  ctx.out.result(out, formatSummary(result))
  return EXIT.ok
}

/**
 * Samples `fn` with V8's profiler (`--cpu-prof`) and writes the `.cpuprofile` under the project's
 * captures folder. Returns its path (project-relative) and the hottest functions.
 */
export async function withCpuProfile<T>(
  project: string,
  fn: () => Promise<T> | T,
): Promise<{ value: T; profilePath: string; hottest: ReturnType<typeof hottestFromCpuProfile> }> {
  const sampler = await createNodePerformance().startSampler!()
  if (!sampler) {
    throw new ShardError(
      'perf/sampling-unavailable',
      'Another CPU profile is running in this process',
      {
        hint: 'Run one profile at a time.',
      },
    )
  }
  let value: T
  let samples: Awaited<ReturnType<typeof sampler.stop>>
  try {
    value = await fn()
  } finally {
    samples = await sampler.stop()
  }
  const dir = join(project, CAPTURES_DIR)
  await mkdir(dir, { recursive: true })
  const file = join(dir, `${captureStamp()}.cpuprofile`)
  await writeFile(file, JSON.stringify(samples.cpuprofile))
  return {
    value,
    profilePath: relative(project, file),
    hottest: hottestFromCpuProfile(samples.cpuprofile as never, 10),
  }
}
