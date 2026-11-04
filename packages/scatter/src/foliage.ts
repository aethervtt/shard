import { type AssetRef, defineResource, type World } from '@aethervtt/shard-core'
import type { Workers } from '@aethervtt/shard-platform'
import { FoliageLayer, FoliageLayers } from '@aethervtt/shard-render'
import { BREEZE, Wind as SharedWind } from '@aethervtt/shard-wind'
import { FOLIAGE } from './rules'
import { finalPlacements, neighborChunks, type SurfaceScatter } from './runtime'
import { P_RADIUS, P_X, type PatchJob, PLACEMENT_STRIDE, type SurfaceChunk } from './surface'

/** A foliage chunk despawns once no camera is within this many times its rule's range. */
const KEEP = 1.1
/** Patches started per frame, across rules. */
const PATCHES_PER_FRAME = 8

/** 0045's wind, as `scatter/Wind` read it: strength 1 is a 6 m/s breeze. */
export interface WindValue {
  /** World-space direction (normalized when used). */
  direction: [number, number, number]
  /** 0 calm, 1 a breeze, 2+ a gale: wind/Wind's speed / 6. */
  strength: number
  /** Gust waves per metre. */
  gustScale: number
}

/**
 * @deprecated Use `Wind` from `@aethervtt/shard-wind` (0096), with speed in m/s. For one release
 * `scatter/Wind` is a view of it: reading or writing it reads or writes wind/Wind (strength =
 * speed / 6), and `shard validate` warns on scenes that set it.
 */
export const Wind = defineResource<WindValue>('scatter/Wind', {
  description:
    'Deprecated (0096): a view of wind/Wind with strength = speed / 6. Set wind/Wind (speed in m/s) instead.',
  deprecated: 'wind/Wind (speed in m/s: strength × 6)',
})

/** `scatter/Wind`'s value: accessors over the world's wind/Wind. */
export function windView(world: World): WindValue {
  const wind = () => world.initResource(SharedWind)
  return {
    get direction() {
      return wind().direction
    },
    set direction(d: [number, number, number]) {
      const w = wind().direction
      w[0] = d[0]
      w[1] = d[1]
      w[2] = d[2]
    },
    get strength() {
      return wind().speed / BREEZE
    },
    set strength(s: number) {
      wind().speed = s * BREEZE
    },
    get gustScale() {
      return wind().gustScale
    },
    set gustScale(g: number) {
      wind().gustScale = g
    },
  }
}

interface FoliageChunkState {
  id: string
  chunk: SurfaceChunk
  job: PatchJob | undefined
  slot: number
  kept: number
  distance: number
  /** The patch's four corners (chunk frame, xyz each, counter-clockwise), for the overlay. */
  corners: Float32Array | undefined
}

/** A foliage rule's GPU layer and the chunks fed to it. */
export class FoliageRule {
  readonly rule: number
  readonly layer: FoliageLayer
  readonly chunks = new Map<string, FoliageChunkState>()

  constructor(rule: number, layer: FoliageLayer) {
    this.rule = rule
    this.layer = layer
  }
}

const viewers = { points: new Float64Array(24), cameras: 0, anchors: 0 }
const rows = new Float32Array(12)
const order: FoliageChunkState[] = []

/**
 * One frame of a surface's foliage (0045): a GPU layer per foliage rule, its chunks around the
 * cameras (ground patches built on the pool, props' footprints kept clear), and each chunk's
 * transform for this frame's origin. Only with a renderer: headless runs have no foliage.
 */
export function updateFoliage(
  world: World,
  ss: SurfaceScatter,
  frame: number,
  workers: Workers | undefined,
): void {
  const layers = world.tryResource(FoliageLayers)
  if (!layers) return
  const surface = ss.surface
  if (ss.foliageVersion !== surface.version) clearFoliage(world, ss)
  ss.foliageVersion = surface.version
  surface.viewers(world, viewers)
  let started = 0
  for (const rule of surface.rules) {
    if (rule.kind !== FOLIAGE) continue
    let fr = ss.foliage.get(rule.index)
    if (!fr) {
      const layer = makeLayer(ss, rule.index)
      if (!layer) continue
      fr = new FoliageRule(rule.index, layers.add(layer))
      ss.foliage.set(rule.index, fr)
    }
    const f = fr
    surface.chunksNear(rule, viewers.points, 0, viewers.cameras, rule.range * KEEP, (chunk, d) => {
      const id = chunk.key
      let c = f.chunks.get(id)
      if (!c) {
        c = { id, chunk, job: undefined, slot: -1, kept: frame, distance: d, corners: undefined }
        f.chunks.set(id, c)
      }
      if (c.kept !== frame) c.distance = d
      else c.distance = Math.min(c.distance, d)
      c.kept = frame
    })
    // Start patches nearest first; feed the GPU what's ready.
    order.length = 0
    for (const c of f.chunks.values()) if (c.kept === frame && c.slot < 0 && !c.job) order.push(c)
    order.sort((a, b) => a.distance - b.distance || (a.id < b.id ? -1 : 1))
    for (const c of order) {
      if (started >= PATCHES_PER_FRAME) break
      c.job = surface.startPatch(c.chunk, workers)
      started++
    }
    for (const c of f.chunks.values()) {
      if (c.kept !== frame) {
        if (c.job) c.job.cancelled = true
        if (c.slot >= 0) f.layer.removeChunk(c.slot)
        f.chunks.delete(c.id)
        continue
      }
      if (c.job && (c.job.ready || !workers || workers.size === 0)) {
        const patch = surface.finishPatch(c.job)
        c.job = undefined
        const n = patch.grid
        c.corners = new Float32Array(12)
        for (const [k, v] of [0, n - 1, n * n - 1, n * (n - 1)].entries())
          c.corners.set(patch.positions.subarray(v * 3, v * 3 + 3), k * 3)
        c.slot = f.layer.allocate()
        f.layer.setChunk(c.slot, { ...patch, avoid: footprints(ss, c.chunk, frame) })
      }
      if (c.slot >= 0) {
        surface.chunkTransform(world, c.chunk, rows)
        f.layer.setTransform(c.slot, rows)
      }
    }
  }
}

/** The layer for a foliage rule: every item's variants as its meshes, weighted. */
function makeLayer(ss: SurfaceScatter, index: number): FoliageLayer | undefined {
  const rule = ss.surface.rules[index]!
  const meshes: AssetRef<'Mesh'>[] = []
  const lods: AssetRef<'Mesh'>[][] = []
  const weights: number[] = []
  let material: AssetRef<'Material'> | null = null
  let prev = 0
  for (const [i, variants] of ss.variants[index]!.entries()) {
    const w = (rule.weights[i]! - prev) / variants.length
    prev = rule.weights[i]!
    for (const v of variants) {
      if (!v.mesh) continue
      meshes.push(v.mesh)
      lods.push(v.lods)
      weights.push((weights.at(-1) ?? 0) + w)
      material ??= v.material
    }
  }
  if (meshes.length === 0 || !material) return undefined
  weights[weights.length - 1] = 1
  const kind = ss.surface.kind === 'planet' ? 'planet' : 'mesh'
  return new FoliageLayer({
    label: `${kind}:${rule.name}`,
    meshes: meshes.slice(0, 32),
    lods: lods.slice(0, 32),
    weights,
    material,
    seed: rule.seed,
    cells: ss.surface.cells[index]!,
    range: rule.range,
    shadowRange: rule.shadowRange,
    scale: [rule.scaleMin, rule.scaleMax],
    align: rule.align,
  })
}

/** Footprints (x, y, z, r) of the props a foliage rule avoids, relative to the chunk's center. */
function footprints(
  ss: SurfaceScatter,
  chunk: SurfaceChunk,
  frame: number,
): Float32Array | undefined {
  const rule = ss.surface.rules[chunk.rule]!
  if (rule.avoid.length === 0) return undefined
  const out: number[] = []
  for (const a of rule.avoid) {
    for (const other of neighborChunks(ss, ss.surface.rules[a]!, chunk, frame)) {
      const p = finalPlacements(ss, other, frame)
      for (let i = 0; i < p.count; i++) {
        const o = i * PLACEMENT_STRIDE
        out.push(
          other.chunk.center[0]! + p.data[o + P_X]! - chunk.center[0]!,
          other.chunk.center[1]! + p.data[o + P_X + 1]! - chunk.center[1]!,
          other.chunk.center[2]! + p.data[o + P_X + 2]! - chunk.center[2]!,
          p.data[o + P_RADIUS]!,
        )
      }
    }
  }
  return out.length > 0 ? Float32Array.from(out) : undefined
}

/** Drops a surface's foliage layers (its rules changed, or it went away). */
export function clearFoliage(world: World, ss: SurfaceScatter): void {
  const layers = world.tryResource(FoliageLayers)
  for (const f of ss.foliage.values()) {
    for (const c of f.chunks.values()) if (c.job) c.job.cancelled = true
    layers?.remove(f.layer)
  }
  ss.foliage.clear()
}
