import { AssetServerResource } from '@aethervtt/shard-assets'
import { defineEvent, defineResource, defineSystem, type World } from '@aethervtt/shard-core'
import type { GpuStatus } from '@aethervtt/shard-gpu'

// The renderer's health (0061): one resource a host reads to show "graphics reset" or "3D
// unavailable" instead of a stale canvas, and to badge what's drawing a fallback.

export type RenderHealthState = 'ok' | 'degraded' | 'lost' | 'failed'

export interface RenderHealthIssue {
  /** `package/what-happened`, e.g. `assets/load-failed`, `render/material-fallback`. */
  code: string
  message: string
  /** What it's about: an asset path, a material type, a feature. */
  ref?: string
  /** When it was first seen, in ms since the epoch. */
  since: number
  /**
   * `degraded` issues make the state `degraded` (something draws a fallback or not at all); `info`
   * ones are reported without changing it (a shader cache miss in a dev build).
   */
  severity: 'degraded' | 'info'
}

export interface RenderHealthValue {
  /**
   * `ok`; `degraded` while any fallback, failed pipeline or unsupported feature is in use; `lost`
   * between a device loss and its recovery; `failed` when recovery gave up.
   */
  state: RenderHealthState
  issues: RenderHealthIssue[]
}

export const RenderHealth = defineResource<RenderHealthValue>('render/Health', {
  description:
    "The renderer's health: ok, degraded (fallbacks in use), lost (device reset in progress) or failed, with the issues behind it.",
  init: () => ({ state: 'ok', issues: [] }),
})

export const RenderHealthChanged = defineEvent<{
  from: RenderHealthState
  to: RenderHealthState
  issues: RenderHealthIssue[]
}>('render/HealthChanged', {
  description: 'RenderHealth moved to another state (ok, degraded, lost, failed).',
})

type Raised = Omit<RenderHealthIssue, 'since'>

/** Issues raised by code other than the renderer's own checks (unsupported features, 0064). */
export const RenderHealthReports = defineResource<{ issues: Map<string, Raised>; version: number }>(
  'render/HealthReports',
  {
    description: 'Health issues raised by features and backends, by code and ref.',
    init: () => ({ issues: new Map(), version: 0 }),
  },
)

/** Raises an issue until `clearHealthIssue` (same code and ref). Raising it again does nothing. */
export function raiseHealthIssue(world: World, issue: Raised): void {
  const reports = world.initResource(RenderHealthReports)
  const key = `${issue.code}|${issue.ref ?? ''}`
  const had = reports.issues.get(key)
  if (had && had.message === issue.message && had.severity === issue.severity) return
  reports.issues.set(key, issue)
  reports.version++
}

export function clearHealthIssue(world: World, code: string, ref?: string): void {
  const reports = world.tryResource(RenderHealthReports)
  if (reports?.issues.delete(`${code}|${ref ?? ''}`)) reports.version++
}

/** Material types drawing through the standard fallback (filled by the forward plugin). */
export const MaterialFallbacks = defineResource<{
  count(): number
  list(): readonly { type: string; error: { code: string; message: string } }[]
}>('render/MaterialFallbacks', {
  description: 'Material types whose shader or pipeline failed, drawn with the standard one.',
})

/** Where the device status comes from (the render plugin's GPU context). */
export interface HealthSources {
  status(): GpuStatus
}

/** Last inputs the health was built from: nothing changed, nothing to rebuild (no allocation). */
interface Seen {
  status: GpuStatus | ''
  fallbacks: number
  materials: number
  reports: number
}

/** Rebuilds RenderHealth when its inputs change, and sends RenderHealthChanged on transitions. */
export function healthSystem(sources: HealthSources) {
  const seen: Seen = { status: '', fallbacks: -1, materials: -1, reports: -1 }
  const since = new Map<string, number>()
  return defineSystem({
    name: 'render/health',
    description: 'Keeps RenderHealth current: device status, fallbacks in use, raised issues.',
    run: (_, world) => {
      const status = sources.status()
      const server = world.tryResource(AssetServerResource)
      const fallbacks = server?.fallbackCount ?? 0
      const fallbackMaterials = world.tryResource(MaterialFallbacks)
      const materials = fallbackMaterials?.count() ?? 0
      const reports = world.tryResource(RenderHealthReports)?.version ?? 0
      if (
        status === seen.status &&
        fallbacks === seen.fallbacks &&
        materials === seen.materials &&
        reports === seen.reports
      )
        return
      seen.status = status
      seen.fallbacks = fallbacks
      seen.materials = materials
      seen.reports = reports
      const now = Date.now()
      const issues: RenderHealthIssue[] = []
      const add = (issue: Raised) => {
        const key = `${issue.code}|${issue.ref ?? ''}`
        let at = since.get(key)
        if (at === undefined) {
          at = now
          since.set(key, at)
        }
        issues.push({ ...issue, since: at })
      }
      if (status === 'lost') {
        add({
          code: 'gpu/device-lost',
          message: 'The GPU device was lost; recovering',
          severity: 'degraded',
        })
      } else if (status === 'failed') {
        add({
          code: 'gpu/recovery-failed',
          message: "The GPU device couldn't be replaced",
          severity: 'degraded',
        })
      }
      for (const f of server?.failed() ?? []) {
        add({ code: f.code, message: f.message, ref: f.path, severity: 'degraded' })
      }
      for (const f of fallbackMaterials?.list() ?? []) {
        add({
          code: 'render/material-fallback',
          message: `Drawn with the standard material: ${f.error.message}`,
          ref: f.type,
          severity: 'degraded',
        })
      }
      for (const issue of world.tryResource(RenderHealthReports)?.issues.values() ?? []) add(issue)
      for (const key of since.keys()) {
        if (!issues.some((i) => `${i.code}|${i.ref ?? ''}` === key)) since.delete(key)
      }
      const state: RenderHealthState =
        status === 'failed'
          ? 'failed'
          : status === 'lost'
            ? 'lost'
            : issues.some((i) => i.severity === 'degraded')
              ? 'degraded'
              : 'ok'
      const health = world.initResource(RenderHealth)
      const from = health.state
      health.state = state
      health.issues = issues
      world.touchResource(RenderHealth)
      if (from !== state) {
        const change = { from, to: state, issues }
        // Systems read it as an event; host code outside the frame loop observes it.
        world.send(RenderHealthChanged, change)
        world.trigger(RenderHealthChanged, change)
      }
    },
  })
}
