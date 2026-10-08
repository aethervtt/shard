import { Rng, t } from '@aethervtt/shard-core'
import { DEG, type MeshBuilder, sinCos } from '@aethervtt/shard-mesh'
import { defineGenerator } from '../generator'
import { fbm } from './shape-noise'

/**
 * The engine's generators (spec 0045): rocks, trees, bushes, grass clumps, and crystals, each with a
 * handful of params whose defaults look right without tuning. Every mesh stands on its origin
 * (y = 0 is the ground) and is in metres.
 *
 * Each writes a part code into the second uv set: x = 0 for bark, stone, or a blade's base, 1 for
 * leaves or a tip (grass and crystals blend along their length); y = a per-vertex shade in [0, 1].
 * `scatter/Vegetation` (and any material that reads `uv1`) tints by it; other materials ignore it.
 */

const sc = new Float64Array(2)

/** Moves the mesh so its lowest point sits `sink` × height below y = 0. */
function standOnGround(b: MeshBuilder, sink: number): void {
  let lo = Number.POSITIVE_INFINITY
  let hi = Number.NEGATIVE_INFINITY
  for (let i = 0; i < b.vertexCount; i++) {
    const y = b.positions[i * 3 + 1]!
    if (y < lo) lo = y
    if (y > hi) hi = y
  }
  b.translate(0, -lo - (hi - lo) * sink, 0)
}

export const RockGenerator = defineGenerator('shard/Rock', {
  description:
    'A boulder: a noisy, faceted, flattened icosphere sitting on its origin, part-buried. LODs at 50% and 20%.',
  params: {
    radius: t.f32({ default: 1, min: 0.05, unit: 'm', description: 'Rough size before noise.' }),
    roughness: t.f32({
      default: 0.5,
      min: 0,
      max: 1,
      description: 'Lumpiness: 0 smooth, 1 craggy.',
    }),
    flatness: t.f32({
      default: 0.3,
      min: 0,
      max: 1,
      description: 'Squash toward a slab: 0 round, 1 flat.',
    }),
    facets: t.u8({
      default: 6,
      max: 32,
      description: 'Flat cuts across the surface, for fractured stone (0: none).',
    }),
    detail: t.u8({
      default: 4,
      min: 1,
      max: 6,
      description: 'Icosphere subdivisions: 4 is 2 562 vertices.',
    }),
  },
  output: 'mesh',
  version: 1,
  run(ctx, p) {
    const b = ctx.mesh.create().icosphere(p.detail, 1)
    const rng = ctx.rng
    // A random ellipsoid, squashed by flatness.
    const sx = 0.85 + rng.float() * 0.3
    const sz = 0.85 + rng.float() * 0.3
    const sy = (0.75 + rng.float() * 0.25) * (1 - 0.6 * p.flatness)
    b.scale(sx, sy, sz)
    // Facets: planes that shave off whatever pokes past them.
    const pos = b.positions
    for (let f = 0; f < p.facets; f++) {
      let x = rng.float() * 2 - 1
      let y = rng.float() * 1.6 - 0.4
      let z = rng.float() * 2 - 1
      const len = Math.sqrt(x * x + y * y + z * z) || 1
      x /= len
      y /= len
      z /= len
      const d = 0.62 + rng.float() * 0.25
      for (let i = 0; i < b.vertexCount; i++) {
        const k = pos[i * 3]! * x + pos[i * 3 + 1]! * y + pos[i * 3 + 2]! * z - d
        if (k <= 0) continue
        pos[i * 3] = pos[i * 3]! - x * k
        pos[i * 3 + 1] = pos[i * 3 + 1]! - y * k
        pos[i * 3 + 2] = pos[i * 3 + 2]! - z * k
      }
    }
    b.normals()
    const seed = ctx.childSeed('shape')
    b.displace((q) => p.roughness * 0.22 * fbm(seed, q[0]! * 1.7, q[1]! * 1.7, q[2]! * 1.7, 4))
    b.scale(p.radius)
    standOnGround(b, 0.15)
    for (let i = 0; i < b.vertexCount; i++) {
      const q = b.positions
      const shade =
        0.5 + 0.5 * fbm(seed + 7, q[i * 3]! * 3, q[i * 3 + 1]! * 3, q[i * 3 + 2]! * 3, 2)
      b.uv1(i, 0, shade)
    }
    b.normals({ angle: p.facets > 0 ? 50 : 180 }).uvsTriplanar(Math.max(0.25, p.radius))
    return ctx.mesh.finish(b, { tangents: true, lods: [0.5, 0.2] })
  },
})

export const TreeGenerator = defineGenerator('shard/Tree', {
  description:
    'A broadleaf tree: a branching skeleton skinned with tubes, leaf cards on the outer branches. LODs at 40% and 12%.',
  params: {
    height: t.f32({ default: 8, min: 0.5, unit: 'm', description: 'About how tall it grows.' }),
    trunkRadius: t.f32({ default: 0.22, min: 0.01, unit: 'm' }),
    levels: t.u8({ default: 2, max: 4, description: 'Branching levels below the trunk.' }),
    branching: t.u8({ default: 5, min: 1, max: 12, description: 'Children per branch.' }),
    spread: t.f32({
      default: 42,
      min: 0,
      max: 90,
      unit: 'deg',
      description: 'Angle between a branch and its parent.',
    }),
    leafDensity: t.f32({
      default: 10,
      min: 0,
      description: 'Leaf cards per metre of outer branch.',
    }),
    leafSize: t.f32({ default: 0.45, min: 0.01, unit: 'm' }),
  },
  output: 'mesh',
  version: 1,
  run(ctx, p) {
    const b = ctx.mesh.create()
    const sk = ctx.mesh.treeSkeleton({
      seed: ctx.childSeed('skeleton'),
      trunk: { length: p.height * 0.55, radius: p.trunkRadius, segments: 8 },
      levels: p.levels,
      branches: p.branching,
      spread: p.spread,
      lengthScale: 0.62,
      start: 0.4,
      gravity: 0.05,
    })
    ctx.mesh.tubeAlong(b, sk, { sides: 8 })
    b.uv1All(0, 0.5)
    const leaves = ctx.mesh.leafCards(b, sk, {
      seed: ctx.childSeed('leaves'),
      density: p.leafDensity,
      size: p.leafSize,
      levels: p.levels > 0 ? [p.levels, Math.max(1, p.levels - 1)] : [0],
    })
    shadeCards(b, leaves, ctx.rng)
    return ctx.mesh.finish(b, { lods: [0.4, 0.12] })
  },
})

export const BushGenerator = defineGenerator('shard/Bush', {
  description:
    'A shrub: several short branching stems from one point, densely leaved. LODs at 40% and 12%.',
  params: {
    radius: t.f32({ default: 0.8, min: 0.05, unit: 'm', description: 'About how wide it grows.' }),
    stems: t.u8({ default: 6, min: 1, max: 24 }),
    leafDensity: t.f32({ default: 18, min: 0, description: 'Leaf cards per metre of branch.' }),
  },
  output: 'mesh',
  version: 1,
  run(ctx, p) {
    const b = ctx.mesh.create()
    const rng = ctx.rng
    let leaves = -1
    for (let s = 0; s < p.stems; s++) {
      const sk = ctx.mesh.treeSkeleton({
        seed: ctx.childSeed(`stem${s}`),
        trunk: {
          length: p.radius * (0.9 + rng.float() * 0.5),
          radius: p.radius * 0.025,
          segments: 4,
        },
        levels: 1,
        branches: 3,
        spread: 35,
        lengthScale: 0.6,
        gravity: 0.2,
        start: 0.3,
      })
      // Lean each stem outward around the center.
      sinCos((s / p.stems) * Math.PI * 2 + rng.float() * 0.6, sc)
      const lean = 0.5 + rng.float() * 0.35
      sinCos(lean, sc2)
      const ax = sc[1]!
      const az = sc[0]!
      const first = b.vertexCount
      ctx.mesh.tubeAlong(b, sk, { sides: 5 })
      b.uv1All(0, 0.4, first)
      const cards = ctx.mesh.leafCards(b, sk, {
        seed: ctx.childSeed(`leaves${s}`),
        density: p.leafDensity,
        size: p.radius * 0.3,
        levels: [0, 1],
        droop: 0.1,
      })
      if (leaves < 0) leaves = cards
      shadeCards(b, cards, rng)
      // Rotate the stem about the horizontal axis perpendicular to its lean direction.
      b.transform(rotationAbout(-az, 0, ax, sc2[0]!, sc2[1]!), first)
    }
    return ctx.mesh.finish(b, { lods: [0.4, 0.12] })
  },
})

const sc2 = new Float64Array(2)

export const GrassClumpGenerator = defineGenerator('shard/GrassClump', {
  description:
    'A clump of grass blades: tapered, bent strips from one root. One-sided (foliage draws two-sided); uv1.x runs 0 at the root to 1 at the tip, for wind and tint. LODs: 5/8 of the blades, wider, at 2 segments; then 5/16 at 1 (a triangle each).',
  params: {
    blades: t.u8({ default: 12, min: 1, max: 64 }),
    height: t.f32({ default: 0.55, min: 0.01, unit: 'm' }),
    width: t.f32({
      default: 0.045,
      min: 0.001,
      unit: 'm',
      description: 'Blade width at the root.',
    }),
    bend: t.f32({ default: 0.35, min: 0, max: 1, description: 'How far blades curve over.' }),
    spread: t.f32({
      default: 0.18,
      min: 0,
      unit: 'm',
      description: 'Radius the roots scatter over.',
    }),
  },
  output: 'mesh',
  version: 2,
  run(ctx, p) {
    // The same clump at three levels: every blade at 4 segments; then fewer, wider blades at 2
    // segments and at 1 (a triangle), so a far clump covers the same ground with far fewer
    // vertices. Foliage draws the coarser levels farther out.
    const clump = (segments: number, keep: number) => {
      const b = ctx.mesh.create()
      const rng = new Rng(ctx.childSeed('blades'))
      for (let k = 0; k < p.blades; k++) {
        sinCos(rng.float() * Math.PI * 2, sc)
        const r = Math.sqrt(rng.float()) * p.spread
        const rx = sc[1]! * r
        const rz = sc[0]! * r
        // Facing and lean: outward from the clump's center, jittered, so from any side about half
        // the (one-sided) blades face the viewer.
        const dx = r > 0 ? rx / r : 1
        const dz = r > 0 ? rz / r : 0
        sinCos(r > 0 ? (rng.float() - 0.5) * 1.2 : rng.float() * Math.PI * 2, sc)
        const fx = dx * sc[1]! - dz * sc[0]!
        const fz = dx * sc[0]! + dz * sc[1]!
        const h = p.height * (0.6 + rng.float() * 0.5)
        const w = (p.width * (0.7 + rng.float() * 0.6)) / keep
        const bend = p.bend * (0.5 + rng.float())
        const shade = rng.float()
        // A golden-ratio sequence picks which blades a coarser level keeps (evenly spread).
        if ((k * 0.618033988749895) % 1 >= keep) continue
        const first = b.vertexCount
        const rows = segments === 1 ? 1 : segments + 1
        for (let s = 0; s < rows; s++) {
          const f = s / segments
          // A quadratic arc: leans out by bend × height at the tip.
          const out = bend * h * f * f
          const y = h * f * (1 - 0.35 * bend * f)
          const half = (w / 2) * (1 - f * 0.92)
          const cx = rx + fx * out
          const cz = rz + fz * out
          // Width runs across the facing direction.
          const wx = -fz * half
          const wz = fx * half
          // The blade's normal: perpendicular to width and the arc's tangent (tf along the facing,
          // ty up), on the facing side, which is the front face.
          const ty = h * (1 - 0.7 * bend * f)
          const tf = 2 * bend * h * f
          const nx = fx * ty
          const ny = -tf
          const nz = fz * ty
          const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1
          b.vertex(cx - wx, y, cz - wz, nx / nl, ny / nl, nz / nl, 0, 1 - f)
          b.vertex(cx + wx, y, cz + wz, nx / nl, ny / nl, nz / nl, 1, 1 - f)
          b.uv1(first + s * 2, f, shade)
          b.uv1(first + s * 2 + 1, f, shade)
        }
        if (segments === 1) {
          // One triangle: the root's two vertices and the tip.
          const out = bend * h
          const tip = b.vertex(
            rx + fx * out,
            h * (1 - 0.35 * bend),
            rz + fz * out,
            fx * h * (1 - 0.7 * bend),
            -2 * bend * h,
            fz * h * (1 - 0.7 * bend),
            0.5,
            0,
          )
          b.uv1(tip, 1, shade)
          b.triangle(first, tip, first + 1)
          continue
        }
        for (let s = 0; s < segments; s++) {
          const a = first + s * 2
          b.quad(a, a + 2, a + 3, a + 1)
        }
      }
      return b.finish()
    }
    return { kind: 'mesh', mesh: clump(4, 1), lods: [clump(2, 0.625), clump(1, 0.3125)] }
  },
})

export const CrystalGenerator = defineGenerator('shard/Crystal', {
  description:
    'A crystal cluster: pointed prisms fanning out from a base, with hard edges. LODs at 50% and 20%.',
  params: {
    count: t.u8({ default: 6, min: 1, max: 32, description: 'Prisms in the cluster.' }),
    length: t.f32({ default: 1.2, min: 0.01, unit: 'm', description: 'The longest prism.' }),
    radius: t.f32({ default: 0.14, min: 0.005, unit: 'm' }),
    spread: t.f32({
      default: 28,
      min: 0,
      max: 80,
      unit: 'deg',
      description: 'How far prisms tilt from upright.',
    }),
    sides: t.u8({ default: 6, min: 3, max: 12 }),
  },
  output: 'mesh',
  version: 1,
  run(ctx, p) {
    const b = ctx.mesh.create()
    const rng = ctx.rng
    for (let k = 0; k < p.count; k++) {
      const main = k === 0
      const len = p.length * (main ? 1 : 0.35 + rng.float() * 0.5)
      const r = p.radius * (main ? 1 : 0.5 + rng.float() * 0.5) * (len / p.length) ** 0.3
      const first = b.vertexCount
      b.lathe([r * 0.85, -r, r, len * 0.72, 0, len], { sides: p.sides, caps: true })
      for (let i = first; i < b.vertexCount; i++) {
        const y = b.positions[i * 3 + 1]!
        b.uv1(i, Math.max(0, Math.min(1, y / len)), rng.float())
      }
      // Tilt about a random horizontal axis, then step out from the center.
      const tilt = (main ? 0.3 : 0.6 + rng.float() * 0.5) * p.spread * DEG
      sinCos(rng.float() * Math.PI * 2, sc)
      sinCos(tilt, sc2)
      const m = rotationAbout(sc[1]!, 0, sc[0]!, sc2[0]!, sc2[1]!)
      const off = main ? 0 : r * 1.4
      m[12] = -sc[0]! * off
      m[14] = sc[1]! * off
      b.transform(m, first)
    }
    standOnGround(b, 0.08)
    b.normals({ angle: 30 })
    return ctx.mesh.finish(b, { lods: [0.5, 0.2] })
  },
})

/** Column-major rotation by the angle with sine `s` and cosine `c` about unit axis (x, y, z). */
function rotationAbout(x: number, y: number, z: number, s: number, c: number): Float64Array {
  const len = Math.sqrt(x * x + y * y + z * z) || 1
  x /= len
  y /= len
  z /= len
  const k = 1 - c
  const m = new Float64Array(16)
  m[0] = c + x * x * k
  m[1] = y * x * k + z * s
  m[2] = z * x * k - y * s
  m[4] = x * y * k - z * s
  m[5] = c + y * y * k
  m[6] = z * y * k + x * s
  m[8] = x * z * k + y * s
  m[9] = y * z * k - x * s
  m[10] = c + z * z * k
  m[15] = 1
  return m
}

/** Leaves (vertices from `first` on): part 1, a shade per card (cards are 6 or 4 vertices × 2). */
function shadeCards(b: MeshBuilder, first: number, rng: Rng): void {
  let shade = rng.float()
  for (let i = first; i < b.vertexCount; i++) {
    if ((i - first) % 12 === 0) shade = rng.float()
    b.uv1(i, 1, shade)
  }
}

/** Every engine generator (importing this module defines them). */
export const ENGINE_GENERATORS = [
  RockGenerator,
  TreeGenerator,
  BushGenerator,
  GrassClumpGenerator,
  CrystalGenerator,
] as const
