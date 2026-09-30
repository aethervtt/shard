import { defineResource } from '@aethervtt/shard-core'
import {
  type GpuUploads,
  UPLOAD_CATEGORIES,
  Upload,
  type UploadCategory,
} from '@aethervtt/shard-gpu'

export interface ViewStats {
  visible: number
  culled: number
  hidden: number
  /** Meshes skipped because their mesh or material isn't loaded yet (or failed). */
  pending: number
  drawCalls: number
  /** Pipeline changes in the opaque pass (sorting keeps these near the number of material types). */
  pipelineSwitches?: number
}

/** What one frame (or a window of frames) wrote to the GPU and rebuilt (0055). */
export interface FrameRecord {
  /** Bytes written, by what they were for. */
  bytes: Record<UploadCategory, number>
  /** Scene data: every byte but `view` (camera and per-frame uniforms). */
  sceneBytes: number
  /** Buffers and textures created. */
  created: number
  /** Structure chunks rebuilt (0055). */
  chunksRebuilt: number
  /** Meshes uploaded to the GPU: new ones, and ones whose data changed. */
  meshesRebuilt: number
  /** Shadow maps (cascades and local shadow views) drawn. */
  shadowMapsRendered: number
}

/** Counts a system adds to during a frame; they land in `lastFrame` when the frame is submitted. */
export interface FrameCounts {
  chunksRebuilt: number
  meshesRebuilt: number
  shadowMapsRendered: number
}

/** Frames `RenderStatsMap.recent` sums over. */
export const RECENT_FRAMES = 60

const FIELDS = UPLOAD_CATEGORIES.length + 4

function frameRecord(): FrameRecord {
  const bytes = {} as Record<UploadCategory, number>
  for (const c of UPLOAD_CATEGORIES) bytes[c] = 0
  return {
    bytes,
    sceneBytes: 0,
    created: 0,
    chunksRebuilt: 0,
    meshesRebuilt: 0,
    shadowMapsRendered: 0,
  }
}

/**
 * Per-view counts from the last frame (a Map by view name), plus what the last frame wrote to the
 * GPU and rebuilt (`lastFrame`) and the sum over the last 60 rendered frames (`recent`).
 */
export class RenderStatsMap extends Map<string, ViewStats> {
  readonly lastFrame: FrameRecord = frameRecord()
  readonly recent: FrameRecord = frameRecord()
  /** Counted during the frame being built. */
  readonly current: FrameCounts = { chunksRebuilt: 0, meshesRebuilt: 0, shadowMapsRendered: 0 }
  /** Frames recorded. */
  frames = 0
  private readonly ring = new Float64Array(RECENT_FRAMES * FIELDS)
  private readonly row = new Float64Array(FIELDS)
  private readonly seen = new Float64Array(UPLOAD_CATEGORIES.length + 1)

  /**
   * Closes a frame: `uploads` is the owner's running total (`gpu.uploads(owner)`); the difference
   * since the last call is this frame's. Allocates nothing.
   */
  endFrame(uploads: GpuUploads | undefined): void {
    const row = this.row
    const seen = this.seen
    const n = UPLOAD_CATEGORIES.length
    for (let i = 0; i < n; i++) {
      const total = uploads ? uploads.bytes[i]! : seen[i]!
      row[i] = total - seen[i]!
      seen[i] = total
    }
    const created = uploads ? uploads.created : seen[n]!
    row[n] = created - seen[n]!
    seen[n] = created
    const cur = this.current
    row[n + 1] = cur.chunksRebuilt
    row[n + 2] = cur.meshesRebuilt
    row[n + 3] = cur.shadowMapsRendered
    cur.chunksRebuilt = cur.meshesRebuilt = cur.shadowMapsRendered = 0
    const ring = this.ring
    const slot = (this.frames % RECENT_FRAMES) * FIELDS
    this.frames++
    const last = this.lastFrame
    const recent = this.recent
    let lastScene = 0
    let recentScene = 0
    for (let i = 0; i < FIELDS; i++) {
      const sum = recentField(recent, i) - ring[slot + i]! + row[i]!
      ring[slot + i] = row[i]!
      setField(last, i, row[i]!)
      setField(recent, i, sum)
      if (i < n && i !== Upload.view) {
        lastScene += row[i]!
        recentScene += sum
      }
    }
    last.sceneBytes = lastScene
    recent.sceneBytes = recentScene
  }
}

function recentField(r: FrameRecord, i: number): number {
  const n = UPLOAD_CATEGORIES.length
  if (i < n) return r.bytes[UPLOAD_CATEGORIES[i]!]
  if (i === n) return r.created
  if (i === n + 1) return r.chunksRebuilt
  if (i === n + 2) return r.meshesRebuilt
  return r.shadowMapsRendered
}

function setField(r: FrameRecord, i: number, v: number): void {
  const n = UPLOAD_CATEGORIES.length
  if (i < n) r.bytes[UPLOAD_CATEGORIES[i]!] = v
  else if (i === n) r.created = v
  else if (i === n + 1) r.chunksRebuilt = v
  else if (i === n + 2) r.meshesRebuilt = v
  else r.shadowMapsRendered = v
}

export const RenderStats = defineResource<RenderStatsMap>('render/Stats', {
  description:
    'Per-view counts from the last frame (visible, culled, hidden, pending, draw calls), and what the last frame and the last 60 wrote to the GPU and rebuilt.',
  init: () => new RenderStatsMap(),
})

export interface GpuMemoryData {
  /** Textures uploaded by the forward renderer. */
  textures: number
  /** Bytes of GPU memory those textures use (all mip levels). */
  textureBytes: number
}

export const GpuMemory = defineResource<GpuMemoryData>('render/GpuMemory', {
  description: 'GPU memory used by uploaded textures.',
  init: () => ({ textures: 0, textureBytes: 0 }),
})

export interface RenderCountersData {
  /** Times a TAA history started over (new view, resize, device loss). Never on origin shifts. */
  taaResets: number
  /** Floating-origin shifts the renderer followed (spec 0040): history moved, not reset. */
  originShifts: number
}

export const RenderCounters = defineResource<RenderCountersData>('render/Counters', {
  description:
    'Running totals since start: TAA history resets and floating-origin shifts followed.',
  init: () => ({ taaResets: 0, originShifts: 0 }),
})
