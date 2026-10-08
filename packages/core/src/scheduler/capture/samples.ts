import type { HotFunction, TraceSample } from './capture'

// Sampling is borrowed (0074): V8's profiler in Node (`.cpuprofile`), the JS Self-Profiling API in
// browsers. These turn either into the summary's hottest functions and the trace's samples track.

/** A V8 `.cpuprofile` (DevTools' `Profiler.Profile`), as `node:inspector` and `--cpu-prof` write it. */
export interface CpuProfile {
  nodes: {
    id: number
    callFrame: { functionName: string; url: string; lineNumber: number; columnNumber?: number }
    hitCount?: number
    children?: number[]
  }[]
  /** µs. */
  startTime: number
  endTime: number
  samples?: number[]
  /** µs between samples. */
  timeDeltas?: number[]
}

/** What `new Profiler(...).stop()` resolves with (JS Self-Profiling). */
export interface SelfProfileTrace {
  resources: string[]
  frames: { name: string; resourceId?: number; line?: number; column?: number }[]
  stacks: { frameId: number; parentId?: number }[]
  /** `timestamp` on the page's performance timeline (ms). */
  samples: { timestamp: number; stackId?: number }[]
}

/** Not code: time V8 spent idle, or the profiler's own root. */
const SKIP = new Set(['(root)', '(idle)'])

function rank(byKey: Map<string, HotFunction>, total: number, limit: number): HotFunction[] {
  const out = [...byKey.values()]
  for (const f of out) {
    f.share = total > 0 ? Math.round((f.selfMs / total) * 1000) / 1000 : 0
    f.selfMs = Math.round(f.selfMs * 1000) / 1000
  }
  out.sort((a, b) => b.selfMs - a.selfMs || (a.name < b.name ? -1 : 1))
  return out.slice(0, limit)
}

/** The functions with the most self time in a `.cpuprofile`. */
export function hottestFromCpuProfile(profile: CpuProfile, limit = 20): HotFunction[] {
  const self = new Map<number, number>()
  const samples = profile.samples ?? []
  const deltas = profile.timeDeltas ?? []
  if (samples.length > 0 && deltas.length === samples.length) {
    // Sample i covers the time until the next one.
    for (let i = 0; i < samples.length; i++) {
      const dt = i + 1 < deltas.length ? deltas[i + 1]! : 0
      self.set(samples[i]!, (self.get(samples[i]!) ?? 0) + Math.max(0, dt) / 1000)
    }
  } else {
    let hits = 0
    for (const node of profile.nodes) hits += node.hitCount ?? 0
    const per = hits > 0 ? (profile.endTime - profile.startTime) / 1000 / hits : 0
    for (const node of profile.nodes) self.set(node.id, (node.hitCount ?? 0) * per)
  }
  const byKey = new Map<string, HotFunction>()
  let total = 0
  for (const node of profile.nodes) {
    const ms = self.get(node.id) ?? 0
    const frame = node.callFrame
    if (ms <= 0 || SKIP.has(frame.functionName)) continue
    total += ms
    const name = frame.functionName || '(anonymous)'
    const key = `${name}|${frame.url}|${frame.lineNumber}`
    let f = byKey.get(key)
    if (!f) {
      f = { name, selfMs: 0, share: 0 }
      if (frame.url) f.url = frame.url
      if (frame.lineNumber >= 0) f.line = frame.lineNumber + 1
      byKey.set(key, f)
    }
    f.selfMs += ms
  }
  return rank(byKey, total, limit)
}

/** The functions on top of the stack most often in a JS Self-Profiling trace. */
export function hottestFromSelfProfile(
  trace: SelfProfileTrace,
  intervalMs: number,
  limit = 20,
): HotFunction[] {
  const byKey = new Map<string, HotFunction>()
  let total = 0
  for (let i = 0; i < trace.samples.length; i++) {
    const s = trace.samples[i]!
    if (s.stackId === undefined) continue
    const next = trace.samples[i + 1]
    const ms = next ? Math.min(next.timestamp - s.timestamp, intervalMs * 4) : intervalMs
    const frame = trace.frames[trace.stacks[s.stackId]!.frameId]!
    const url = frame.resourceId === undefined ? undefined : trace.resources[frame.resourceId]
    const name = frame.name || '(anonymous)'
    const key = `${name}|${url ?? ''}|${frame.line ?? -1}`
    let f = byKey.get(key)
    if (!f) {
      f = { name, selfMs: 0, share: 0 }
      if (url) f.url = url
      if (frame.line !== undefined) f.line = frame.line
      byKey.set(key, f)
    }
    f.selfMs += ms
    total += ms
  }
  return rank(byKey, total, limit)
}

/**
 * A JS Self-Profiling trace as stretches of the same top function, for the trace's samples track.
 * `offset` moves the page's timeline onto the profiler's clock.
 */
export function samplesFromSelfProfile(
  trace: SelfProfileTrace,
  intervalMs: number,
  offset = 0,
): TraceSample[] {
  const out: TraceSample[] = []
  for (let i = 0; i < trace.samples.length; i++) {
    const s = trace.samples[i]!
    if (s.stackId === undefined) continue
    const name = trace.frames[trace.stacks[s.stackId]!.frameId]!.name || '(anonymous)'
    const next = trace.samples[i + 1]
    const ms = next ? Math.min(next.timestamp - s.timestamp, intervalMs * 4) : intervalMs
    const last = out[out.length - 1]
    if (
      last &&
      last.name === name &&
      Math.abs(last.start + last.ms - (s.timestamp + offset)) < 1e-6
    ) {
      last.ms += ms
      continue
    }
    out.push({ name, start: s.timestamp + offset, ms })
  }
  return out
}
