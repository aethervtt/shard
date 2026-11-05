import { defineSchema, ProfilerResource, t, type World } from '@aethervtt/shard-core'
import { type CaptureDebugView, encodePng, toBase64 } from '@aethervtt/shard-protocol'
import { Gpu, readTextureLayer } from '@aethervtt/shard-render'
import type { AppMethod } from '@aethervtt/shard-runtime'
import { WaveRender } from './render-state'
import { fadeWeight, seaAt, seaSample, type WaveSet, WaveSets, waveTick } from './sea'
import {
  buildSea,
  checkCascades,
  DEFAULT_CASCADES,
  type Sea,
  type SpectrumParams,
} from './spectrum'

function describeSea(sea: Sea) {
  return {
    hs: sea.hs,
    tp: sea.tp,
    sampledHs: sea.sampledHs,
    evaluatorHs: sea.evaluatorHs,
    components: sea.componentCount,
    cascades: sea.cascades.map((c, i) => ({
      cascade: i,
      length: c.length,
      /** Wavelengths it carries (m): longest, shortest. */
      band: [c.kMin > 0 ? (2 * Math.PI) / c.kMin : null, (2 * Math.PI) / c.kMax],
      resolution: sea.params.resolution,
      hs: 4 * Math.sqrt(c.variance),
    })),
  }
}

function describeSet(world: World, set: WaveSet) {
  const tick = waveTick(world)
  return {
    entity: set.entity,
    problem: set.problem ? { code: set.problem.code, message: set.problem.message } : null,
    wind: {
      speed: set.sea.params.windSpeed,
      direction: [set.sea.params.windX, 0, set.sea.params.windZ],
    },
    ...describeSea(set.sea),
    crossfade: set.old ? { from: set.fadeStart, weight: fadeWeight(set, tick) } : null,
    layer: set.layer,
  }
}

/** The `waves` section of `water.describe` (0098). */
export function describeWaves(world: World) {
  const sets = world.tryResource(WaveSets)
  const gpu = world.tryResource(WaveRender)
  return {
    seas: [...(sets?.sets.values() ?? [])].map((s) => describeSet(world, s)),
    gpu: gpu
      ? {
          resolution: gpu.n,
          layers: gpu.layers.length,
          ms: world.tryResource(ProfilerResource)?.timing('gpu:water-waves')?.last ?? null,
        }
      : null,
  }
}

const vec = (d: number[]) => t.vec3({ default: d as [number, number, number] })

/** A spectrum from `water.waves`'s parameters, OceanWaves' defaults for the rest. */
function previewParams(p: Record<string, unknown>): SpectrumParams {
  const dir = (p.windDirection as number[]) ?? [1, 0, 0]
  const swell = (p.swellDirection as number[]) ?? [1, 0, 0]
  const flat = (d: number[]) => {
    const l = Math.hypot(d[0]!, d[2]!) || 1
    return [d[0]! / l, d[2]! / l]
  }
  const lengths = (p.cascades as number[] | undefined)?.length
    ? (p.cascades as number[])
    : DEFAULT_CASCADES
  const resolution = (p.resolution as number) || 128
  checkCascades(-1, lengths, resolution)
  return {
    seed: (p.seed as number) ?? 1,
    windSpeed: (p.windSpeed as number) ?? 10,
    windX: flat(dir)[0]!,
    windZ: flat(dir)[1]!,
    fetch: ((p.fetch as number) ?? 100) * 1000,
    gamma: (p.gamma as number) ?? 3.3,
    spread: (p.spread as number) ?? 1,
    swell: ((p.swellHeight as number) ?? 0) > 0,
    swellHeight: (p.swellHeight as number) ?? 0,
    swellPeriod: (p.swellPeriod as number) ?? 11,
    swellX: flat(swell)[0]!,
    swellZ: flat(swell)[1]!,
    swellSpread: 0.3,
    depth: (p.depth as number) ?? 0,
    choppiness: (p.choppiness as number) ?? 1,
    lengths,
    resolution,
  }
}

/** The CPU evaluator's heights over a square `size` metres wide at `pixels`², as a grey PNG. */
async function heightPng(sea: Sea, size: number, pixels: number) {
  const set = {
    entity: -1,
    key: new Float64Array(0),
    sea,
    old: undefined,
    fadeStart: 0,
    layer: -1,
    foam: [0, 0, 0],
    version: 0,
    problem: null,
    seen: 0,
  } as unknown as WaveSet
  const out = seaSample()
  const heights = new Float64Array(pixels * pixels)
  let lo = Infinity
  let hi = -Infinity
  for (let y = 0; y < pixels; y++) {
    for (let x = 0; x < pixels; x++) {
      const h = seaAt(set, (x / pixels) * size, (y / pixels) * size, 0, 0, Infinity, out).height
      heights[y * pixels + x] = h
      lo = Math.min(lo, h)
      hi = Math.max(hi, h)
    }
  }
  const data = new Uint8Array(pixels * pixels * 4)
  for (let i = 0; i < heights.length; i++) {
    const v = Math.round((255 * (heights[i]! - lo)) / Math.max(hi - lo, 1e-6))
    data.set([v, v, v, 255], i * 4)
  }
  return {
    mimeType: 'image/png',
    width: pixels,
    height: pixels,
    range: [lo, hi],
    data: toBase64(await encodePng(data, pixels, pixels)),
  }
}

export const waveMethods: AppMethod[] = [
  {
    name: 'water.waves',
    description:
      'Previews a sea (0098) without touching the scene: the spectrum’s significant wave height (Hs) and peak period, what the cascades and the CPU evaluator carry, and a PNG of the evaluator’s heights over a square (default 256 m, at t = 0).',
    params: defineSchema('water/WavesParams', {
      seed: t.u32({ default: 1 }),
      windSpeed: t.f32({ default: 10, unit: 'm/s' }),
      windDirection: vec([1, 0, 0]),
      fetch: t.f32({ default: 100, unit: 'km' }),
      gamma: t.f32({ default: 3.3 }),
      spread: t.f32({ default: 1 }),
      swellHeight: t.f32({ default: 0, unit: 'm', description: '0: no swell.' }),
      swellPeriod: t.f32({ default: 11, unit: 's' }),
      swellDirection: vec([1, 0, 0]),
      depth: t.f32({ default: 0, unit: 'm' }),
      choppiness: t.f32({ default: 1 }),
      cascades: t.list(t.f32(), {
        description: 'Patch lengths, largest first (default 250, 17, 5).',
      }),
      resolution: t.u32({ default: 128, description: '128, 256 or 512.' }),
      size: t.f32({ default: 256, unit: 'm', description: 'Width of the square the PNG shows.' }),
      pixels: t.u32({ default: 128, max: 512 }),
    }),
    handler: async (_, p) => {
      const sea = buildSea(previewParams(p))
      return {
        ...describeSea(sea),
        image: await heightPng(sea, (p.size as number) || 256, (p.pixels as number) || 128),
      }
    },
  },
]

/** One channel of every resolved cascade layer, side by side, mapped to grey by its range. */
async function cascadeImage(world: World, layerOf: (cascade: number) => number, channel: number) {
  const w = world.tryResource(WaveRender)
  const gpu = world.tryResource(Gpu)
  const n = w?.n ?? 0
  if (!w || !gpu || !w.output || n === 0 || w.layers.length === 0) {
    return { width: 1, height: 1, data: new Uint8Array([0, 0, 0, 255]) }
  }
  const count = w.layers.length
  const data = new Uint8Array(n * count * n * 4)
  for (let c = 0; c < count; c++) {
    const floats = (await readTextureLayer(gpu, w.output, layerOf(w.layers[c]!.layer))).data
    let lo = Infinity
    let hi = -Infinity
    for (let i = 0; i < n * n; i++) {
      lo = Math.min(lo, floats[i * 4 + channel]!)
      hi = Math.max(hi, floats[i * 4 + channel]!)
    }
    if (channel === 3) {
      lo = 0
      hi = 1
    }
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const v = Math.round(
          (255 * (floats[(y * n + x) * 4 + channel]! - lo)) / Math.max(hi - lo, 1e-6),
        )
        data.set([v, v, v, 255], (y * n * count + c * n + x) * 4)
      }
    }
  }
  return { width: n * count, height: n, data }
}

/** `render.capture { debug: 'water-cascades' }`: each cascade's height field, side by side. */
export const waterCascadesView: CaptureDebugView = {
  description: "The sea's cascades (0098): each one's height, largest first.",
  capture: (world) => cascadeImage(world, (l) => l * 2, 1),
}

/** `render.capture { debug: 'water-foam' }`: each cascade's foam, side by side, white where foamy. */
export const waterFoamView: CaptureDebugView = {
  description: "The sea's foam (0098), per cascade.",
  capture: (world) => cascadeImage(world, (l) => l * 2, 3),
}
