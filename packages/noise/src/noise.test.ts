import { hashSeed, type ShardError } from '@aethervtt/shard-core'
import { allocationChecks, gcWindow } from '@aethervtt/shard-core/test-env'
import { createInlineWorkers } from '@aethervtt/shard-platform'
import { createNodeWorkers } from '@aethervtt/shard-platform-node'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  directionToFace,
  faceToDirection,
  loadNoiseKernel,
  NoiseGraph,
  noiseKernel,
  parseGraph,
  sampleGrid2d,
  sampleGrid2dAsync,
  sampleNoise,
  sampleNoiseAsync,
  sampleNoiseGradient,
  sampleOffset,
  sampleSpherePatch,
  sampleSpherePatchAsync,
} from '.'
import { evalProgram } from './kernel'
import { PLANET } from './planet'
import { perlin3Reference, simplex3Reference } from './reference'

const graph = (node: unknown, extra: Record<string, unknown> = {}) =>
  NoiseGraph.fromJson({ output: 'n', nodes: { n: node }, ...extra })

function lcg(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

function randomPoints(count: number, stride: number, span: number, seed = 1): Float32Array {
  const r = lcg(seed)
  const p = new Float32Array(count * stride)
  for (let i = 0; i < p.length; i++) p[i] = (r() - 0.5) * span
  return p
}

function errorOf(f: () => unknown): ShardError {
  try {
    f()
  } catch (err) {
    return err as ShardError
  }
  throw new Error('expected an error')
}

/** FNV-1a over the bytes of a float array: a checksum of exact values. */
function checksum(a: Float32Array): string {
  const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength)
  let h = 0x811c9dc5
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i]!, 0x01000193)
  return (h >>> 0).toString(16).padStart(8, '0')
}

beforeAll(async () => {
  await loadNoiseKernel()
})

describe('validation', () => {
  it('reports a cycle with a pointer to the node', () => {
    const { errors } = parseGraph({
      output: 'a',
      nodes: { a: { add: ['b', 1] }, b: { multiply: ['a', 2] } },
    })
    expect(errors.map((e) => e.code)).toEqual(['noise/cycle'])
    expect(errors[0]!.path).toBe('/nodes/a')
    expect(errors[0]!.message).toContain('a → b → a')
  })

  it('reports an unknown node where it is referenced', () => {
    const err = errorOf(() =>
      NoiseGraph.fromJson({
        output: 'h',
        nodes: { h: { add: ['hills', { multiply: ['mask', 2] }] }, hills: { perlin: {} } },
      }),
    )
    expect(err.code).toBe('noise/unknown-node')
    expect(err.path).toBe('/nodes/h/add/1/multiply/0')
    expect(err.hint).toContain('h, hills')
  })

  it('rejects 20 octaves', () => {
    const err = errorOf(() => graph({ fbm: { octaves: 20 } }))
    expect(err.code).toBe('noise/too-many-octaves')
    expect(err.path).toBe('/nodes/n/fbm/octaves')
  })

  it('reports every error at once, with codes for arity and domain', () => {
    const { errors } = parseGraph({
      output: 'missing',
      nodes: {
        a: { add: ['b'] },
        b: { lerp: { a: 1, b: 2 } },
        c: { simplex: { dims: 4 } },
        d: { curve: { input: 1, points: [[0, 0]] } },
        e: { fbm: { gain: 'high' } },
        f: { mystery: {} },
      },
    })
    const codes = errors.map((e) => `${e.code} ${e.path}`)
    expect(codes).toContain('noise/arity /nodes/a/add')
    expect(codes).toContain('noise/arity /nodes/b/lerp/t')
    expect(codes).toContain('noise/domain-mismatch /nodes/c/simplex/dims')
    expect(codes).toContain('noise/arity /nodes/d/curve/points')
    expect(codes).toContain('noise/invalid-param /nodes/e/fbm/gain')
    expect(codes).toContain('noise/unknown-type /nodes/f/mystery')
    expect(codes).toContain('noise/unknown-node /output')
  })

  it('rejects frequencies too fine for the extent', () => {
    const err = errorOf(() => graph({ fbm: { octaves: 16, frequency: 2 } }, { extent: 7e7 }))
    expect(err.code).toBe('noise/frequency-too-high')
    expect(err.path).toBe('/nodes/n/fbm')
    // 20 cm features at gas-giant radius are fine; 2 cm ones on a 4×10⁷ m planet too.
    expect(() => graph({ simplex: { frequency: 5 } }, { extent: 7e7 })).not.toThrow()
    expect(() => graph({ simplex: { frequency: 50 } }, { extent: 4e7 })).not.toThrow()
    // And sampling past the i32 range at run time says the same.
    const g = graph({ simplex: { frequency: 50 } })
    const e2 = errorOf(() =>
      sampleOffset(g, 1, [1e9, 0, 0], new Float32Array(3), new Float32Array(1)),
    )
    expect(e2.code).toBe('noise/frequency-too-high')
  })
})

describe('sources', () => {
  const N = 1_000_000
  const cases: [string, unknown, number, number, number][] = [
    // name, node, lower bound, upper bound, expected mean
    ['value 2D', { value: { dims: 2 } }, -1, 1, 0],
    ['value 3D', { value: {} }, -1, 1, 0],
    ['perlin 2D', { perlin: { dims: 2 } }, -1, 1, 0],
    ['perlin 3D', { perlin: {} }, -1, 1, 0],
    ['simplex 2D', { simplex: { dims: 2 } }, -1, 1, 0],
    ['simplex 3D', { simplex: {} }, -1, 1, 0],
    ['cellular f1 2D', { cellular: { dims: 2 } }, 0, 1.25, 0.43],
    ['cellular f1 3D', { cellular: {} }, 0, 1.25, 0.52],
    ['cellular f2 3D', { cellular: { return: 'f2' } }, 0, 1.5, 0.72],
    ['cellular f2-f1 3D', { cellular: { return: 'f2-f1' } }, 0, 1.25, 0.2],
    ['cellular cell 3D', { cellular: { return: 'cell' } }, -1, 1, 0],
    ['cellular manhattan', { cellular: { distance: 'manhattan' } }, 0, 2, 0.77],
    ['cellular chebyshev', { cellular: { distance: 'chebyshev' } }, 0, 1, 0.42],
    ['fbm', { fbm: { octaves: 6 } }, -1, 1, 0],
    ['ridged', { ridged: { octaves: 6 } }, -1, 1, -0.05],
    ['billow', { billow: { octaves: 4 } }, -1, 1, -0.29],
  ]
  const pts3 = randomPoints(N, 3, 400)

  for (const [name, node, lo, hi, mean] of cases) {
    it(`${name}: range [${lo}, ${hi}], mean ${mean}`, () => {
      const g = graph(node)
      const out = new Float32Array(N)
      sampleNoise(g, 7, pts3, out)
      let min = Infinity
      let max = -Infinity
      let sum = 0
      for (let i = 0; i < N; i++) {
        const v = out[i]!
        if (v < min) min = v
        if (v > max) max = v
        sum += v
      }
      expect(min).toBeGreaterThanOrEqual(lo)
      expect(max).toBeLessThanOrEqual(hi)
      expect(max - min).toBeGreaterThan((hi - lo) * 0.5)
      expect(Math.abs(sum / N - mean)).toBeLessThan(0.02)
    })
  }

  it('simplex 4D covers [-1, 1] with mean 0', () => {
    const g = graph({ simplex: { dims: 4 } }, { dimensions: 4 })
    const out = new Float32Array(N)
    sampleNoise(g, 3, randomPoints(N, 4, 400), out)
    let sum = 0
    let min = Infinity
    let max = -Infinity
    for (const v of out) {
      sum += v
      min = Math.min(min, v)
      max = Math.max(max, v)
    }
    expect(min).toBeGreaterThanOrEqual(-1)
    expect(max).toBeLessThanOrEqual(1)
    expect(max - min).toBeGreaterThan(1.5)
    expect(Math.abs(sum / N)).toBeLessThan(0.02)
  })

  it('is continuous: nearby points give nearby values', () => {
    for (const node of [
      { simplex: {} },
      { perlin: {} },
      { value: {} },
      { simplex: { dims: 2 } },
      { cellular: {} },
    ]) {
      const g = graph(node)
      const p = randomPoints(2000, 3, 50, 9)
      const q = p.map((v, i) => (i % 3 === 0 ? v + 1e-3 : v))
      const a = new Float32Array(2000)
      const b = new Float32Array(2000)
      sampleNoise(g, 1, p, a)
      sampleNoise(g, 1, q, b)
      for (let i = 0; i < 2000; i++) expect(Math.abs(a[i]! - b[i]!)).toBeLessThan(0.05)
    }
  })
})

describe('determinism', () => {
  it('gives the same values for a seed (golden checksum), and different ones per seed', () => {
    const g = NoiseGraph.fromJson(PLANET)
    const p = randomPoints(4096, 3, 20, 5)
    const out = new Float32Array(4096)
    sampleNoise(g, 42, p, out)
    // The same checksum the playground's #noise page shows in Chrome and Tauri.
    expect(checksum(out)).toBe(GOLDEN_PLANET)
    const other = new Float32Array(4096)
    sampleNoise(g, 43, p, other)
    expect(checksum(other)).not.toBe(checksum(out))
  })

  it('the SIMD and scalar kernels agree bitwise', async () => {
    const scalar = await loadNoiseKernel({ simd: false })
    const simd = await loadNoiseKernel({ simd: true })
    expect(scalar.simd).toBe(false)
    const graphs = [
      NoiseGraph.fromJson(PLANET),
      graph({ cellular: { return: 'f2-f1', distance: 'manhattan' } }),
      graph({ billow: { source: 'perlin', octaves: 5 } }),
      graph({ fbm: { source: 'value', dims: 2 } }),
      graph({ simplex: { dims: 4 } }, { dimensions: 4 }),
      graph({ power: { input: { terrace: { input: { simplex: {} }, steps: 5 } }, exponent: 1.7 } }),
    ]
    for (const g of graphs) {
      const stride = g.program.dimensions === 4 ? 4 : 3
      const p = randomPoints(10_000, stride, 100, 3)
      const a = new Float32Array(10_000)
      const b = new Float32Array(10_000)
      evalProgram(simd.state, g.program, 9, g.program.zeroOrigins, p, stride, 10_000, a)
      evalProgram(scalar.state, g.program, 9, g.program.zeroOrigins, p, stride, 10_000, b)
      expect(checksum(a)).toBe(checksum(b))
    }
  })

  it("changing one node's seed changes only that layer", () => {
    const base = {
      output: 'sum',
      nodes: { a: { simplex: { seed: 1 } }, b: { perlin: { seed: 2 } }, sum: { add: ['a', 'b'] } },
    }
    const changed = structuredClone(base)
    changed.nodes.b.perlin.seed = 3
    const g1 = NoiseGraph.fromJson(base)
    const g2 = NoiseGraph.fromJson(changed)
    const p = randomPoints(500, 3, 30)
    const a1 = new Float32Array(500)
    const a2 = new Float32Array(500)
    sampleNoise(g1, 11, p, a1, 'a')
    sampleNoise(g2, 11, p, a2, 'a')
    expect(checksum(a1)).toBe(checksum(a2))
    sampleNoise(g1, 11, p, a1)
    sampleNoise(g2, 11, p, a2)
    expect(checksum(a1)).not.toBe(checksum(a2))
    // Layer seeds mix with the sample seed through hashSeed.
    expect(hashSeed(11, 1)).not.toBe(hashSeed(12, 1))
  })

  it('round-trips through the importer artifact to the same program', () => {
    const g = NoiseGraph.fromJson(PLANET, { name: 'planet' })
    const back = NoiseGraph.fromArtifact(JSON.parse(JSON.stringify(g.toArtifact())))
    expect(back.hash).toBe(g.hash)
    expect([...back.program.consts]).toEqual([...g.program.consts])
    const p = randomPoints(300, 3, 10)
    const a = new Float32Array(300)
    const b = new Float32Array(300)
    sampleNoise(g, 1, p, a)
    sampleNoise(back, 1, p, b)
    expect(checksum(a)).toBe(checksum(b))
  })
})

describe('operators', () => {
  const p = randomPoints(2000, 3, 20, 4)
  const values = (g: NoiseGraph, node?: string) => {
    const out = new Float32Array(2000)
    sampleNoise(g, 5, p, out, node)
    return out
  }
  const withSource = (op: unknown) =>
    NoiseGraph.fromJson({
      output: 'op',
      nodes: { s: { simplex: { frequency: 0.3 } }, t: { perlin: { seed: 4 } }, op },
    })
  const close = (a: number, b: number, eps = 2e-6) =>
    expect(Math.abs(a - b)).toBeLessThanOrEqual(eps * (1 + Math.abs(b)))

  it('combine: add, multiply, min, max, lerp', () => {
    const cases: [unknown, (s: number, t: number) => number][] = [
      [{ add: ['s', 't', 0.25] }, (s, t) => s + t + 0.25],
      [{ multiply: ['s', 't'] }, (s, t) => s * t],
      [{ min: ['s', 't'] }, (s, t) => Math.min(s, t)],
      [{ max: ['s', 0] }, (s) => Math.max(s, 0)],
      [{ lerp: { a: 's', b: 't', t: 0.25 } }, (s, t) => s + 0.25 * (t - s)],
    ]
    for (const [op, f] of cases) {
      const g = withSource(op)
      const s = values(g, 's')
      const t = values(g, 't')
      const o = values(g)
      for (let i = 0; i < 2000; i++) close(o[i]!, f(s[i]!, t[i]!))
    }
  })

  it('shape: remap, clamp, curve, terrace, abs, power, select', () => {
    const cases: [unknown, (s: number, t: number) => number, number?][] = [
      [{ remap: { input: 's', from: [-1, 1], to: [0, 10] } }, (s) => 5 * (s + 1)],
      [
        { remap: { input: 's', from: [0.1, 0.4], to: [0, 1], clamp: true } },
        (s) => Math.min(1, Math.max(0, (s - 0.1) / 0.3)),
      ],
      [{ clamp: { input: 's', min: -0.2, max: 0.3 } }, (s) => Math.min(0.3, Math.max(-0.2, s))],
      [
        {
          curve: {
            input: 's',
            points: [
              [-1, -1],
              [0, 0.5],
              [1, 1],
            ],
          },
        },
        (s) => (s < 0 ? -1 + (s + 1) * 1.5 : 0.5 + s * 0.5),
      ],
      [{ abs: 's' }, (s) => Math.abs(s)],
      [{ power: { input: 's', exponent: 3 } }, (s) => s * s * s, 1e-5],
      [
        { power: { input: 's', exponent: 0.5 } },
        (s) => Math.sign(s) * Math.sqrt(Math.abs(s)),
        1e-5,
      ],
      [{ select: { a: 's', b: 't', control: 's', threshold: 0.1 } }, (s, t) => (s >= 0.1 ? t : s)],
    ]
    for (const [op, f, eps] of cases) {
      const g = withSource(op)
      const s = values(g, 's')
      const t = values(g, 't')
      const o = values(g)
      for (let i = 0; i < 2000; i++) close(o[i]!, f(s[i]!, t[i]!), eps ?? 1e-5)
    }
  })

  it('terrace makes flat steps; sharpness 0 leaves the input alone', () => {
    const flat = withSource({ terrace: { input: 's', steps: 4, sharpness: 0 } })
    const s = values(flat, 's')
    const o = values(flat)
    for (let i = 0; i < 2000; i++) close(o[i]!, s[i]!, 1e-5)
    const steep = withSource({ terrace: { input: 's', steps: 4, sharpness: 1 } })
    const levels = new Set(Array.from(values(steep), (v) => Math.round(v * 1000)))
    expect(levels.size).toBeLessThanOrEqual(6)
  })

  it('scale doubles frequencies and translate shifts; warp by 0 changes nothing', () => {
    const a = graph({ scale: { input: { simplex: { frequency: 1 } }, by: 2 } })
    const b = graph({ simplex: { frequency: 2 } })
    expect([...values(a)]).toEqual([...values(b)])
    const moved = graph({ translate: { input: { perlin: {} }, by: [0.5, 0, 0] } })
    const plain = graph({ perlin: {} })
    const shifted = randomPoints(2000, 3, 20, 4).map((v, i) => (i % 3 === 0 ? v + 0.5 : v))
    const m = values(moved)
    const q = new Float32Array(2000)
    sampleNoise(plain, 5, shifted, q)
    for (let i = 0; i < 2000; i++) close(m[i]!, q[i]!, 1e-5)
    const still = graph({ warp: { input: { simplex: {} }, by: { perlin: {} }, amount: 0 } })
    expect([...values(still)]).toEqual([...values(graph({ simplex: {} }))])
    const warped = graph({ warp: { input: { simplex: {} }, by: { perlin: {} }, amount: 0.5 } })
    expect([...values(warped)]).not.toEqual([...values(graph({ simplex: {} }))])
  })

  it('bare numbers and constants are inputs', () => {
    const g = NoiseGraph.fromJson({ output: 'k', nodes: { k: { add: [{ constant: 0.5 }, 0.25] } } })
    expect([...values(g)].every((v) => v === 0.75)).toBe(true)
  })

  it('gradients match finite differences of the samples', () => {
    const g = graph({ fbm: { octaves: 3 } })
    const n = 200
    const pts = randomPoints(n, 3, 10, 8)
    const out = new Float32Array(n)
    const dx = new Float32Array(n)
    const dy = new Float32Array(n)
    const dz = new Float32Array(n)
    sampleNoiseGradient(g, 2, pts, out, dx, dy, dz)
    const h = 1e-3
    const plus = pts.map((v, i) => (i % 3 === 1 ? v + h : v))
    const minus = pts.map((v, i) => (i % 3 === 1 ? v - h : v))
    const a = new Float32Array(n)
    const b = new Float32Array(n)
    sampleNoise(g, 2, plus, a)
    sampleNoise(g, 2, minus, b)
    for (let i = 0; i < n; i++) {
      const fd = (a[i]! - b[i]!) / (2 * h)
      expect(Math.abs(dy[i]! - fd)).toBeLessThan(0.05 * (1 + Math.abs(fd)))
    }
  })
})

describe('origin-offset sampling', () => {
  const tolerance = (ref: number) => 1e-5 * (1 + Math.abs(ref))
  // A 0.5 m-wavelength octave (frequency 2) 7×10⁷ m from the origin: a gas giant's surface.
  const origin = [7e7, 1.3e5, -2.1e6]

  for (const kind of ['simplex', 'perlin'] as const) {
    it(`${kind}: matches the f64 reference at 7×10⁷ m; plain f32 sampling doesn't`, () => {
      const g = graph({ [kind]: { frequency: 2, seed: 5 } })
      const seed = hashSeed(77, 5)
      const ref = kind === 'simplex' ? simplex3Reference : perlin3Reference
      const n = 4096
      // A chunk's worth of local offsets: ±4 m, 16 cells of the 0.5 m octave.
      const local = randomPoints(n, 3, 8, 12)
      const out = new Float32Array(n)
      sampleOffset(g, 77, origin, local, out)
      let worst = 0
      for (let i = 0; i < n; i++) {
        const r = ref(
          seed,
          2 * (origin[0]! + local[i * 3]!),
          2 * (origin[1]! + local[i * 3 + 1]!),
          2 * (origin[2]! + local[i * 3 + 2]!),
        )
        worst = Math.max(worst, Math.abs(out[i]! - r) / tolerance(r))
      }
      expect(worst).toBeLessThanOrEqual(1)

      const absolute = new Float32Array(n * 3)
      for (let i = 0; i < n * 3; i++) absolute[i] = origin[i % 3]! + local[i]!
      const plain = new Float32Array(n)
      sampleNoise(g, 77, absolute, plain)
      let failures = 0
      for (let i = 0; i < n; i++) {
        const r = ref(
          seed,
          2 * (origin[0]! + local[i * 3]!),
          2 * (origin[1]! + local[i * 3 + 1]!),
          2 * (origin[2]! + local[i * 3 + 2]!),
        )
        if (Math.abs(plain[i]! - r) > tolerance(r)) failures++
      }
      expect(failures).toBeGreaterThan(n * 0.9)
    })
  }

  it('neighboring chunks agree where they meet', () => {
    // The planet graph with features from 5 m to 100 km, on an Earth-sized planet.
    const g = NoiseGraph.fromJson({
      ...PLANET,
      nodes: { ...PLANET.nodes, root: { scale: { input: 'height', by: 1e-4 } } },
      output: 'root',
    })
    const a = [6.4e6, 12.5, -3]
    const b = [6.4e6 + 16, 12.5, -3]
    // The same world point, local to each chunk.
    const pa = new Float32Array([8, 1, 2])
    const pb = new Float32Array([-8, 1, 2])
    const va = new Float32Array(1)
    const vb = new Float32Array(1)
    sampleOffset(g, 3, a, pa, va)
    sampleOffset(g, 3, b, pb, vb)
    expect(Math.abs(va[0]! - vb[0]!)).toBeLessThan(1e-5)
  })
})

describe('helpers', () => {
  it('faceToDirection and directionToFace invert each other', () => {
    const d = new Float64Array(3)
    const uv = new Float64Array(2)
    for (let face = 0; face < 6; face++) {
      for (const [u, v] of [
        [0, 0],
        [0.5, -0.25],
        [-0.9, 0.9],
      ]) {
        faceToDirection(face, u!, v!, d)
        expect(Math.hypot(d[0]!, d[1]!, d[2]!)).toBeCloseTo(1, 12)
        expect(directionToFace(d[0]!, d[1]!, d[2]!, uv)).toBe(face)
        expect(uv[0]).toBeCloseTo(u!, 10)
        expect(uv[1]).toBeCloseTo(v!, 10)
      }
    }
  })

  it('sampleSpherePatch equals sampling direction × radius around the patch center', () => {
    const g = NoiseGraph.fromJson(PLANET)
    const patch = { face: 2, x0: -0.25, y0: 0.1, extent: 0.02, resolution: 9, radius: 6.4e6 }
    const out = new Float32Array(81)
    sampleSpherePatch(g, 1, patch, out)
    const center = new Float64Array(3)
    faceToDirection(2, -0.24, 0.11, center)
    const d = new Float64Array(3)
    const local = new Float32Array(81 * 3)
    for (let j = 0; j < 9; j++) {
      for (let i = 0; i < 9; i++) {
        faceToDirection(2, -0.25 + (0.02 * i) / 8, 0.1 + (0.02 * j) / 8, d)
        for (let c = 0; c < 3; c++) local[(j * 9 + i) * 3 + c] = d[c]! * 6.4e6 - center[c]! * 6.4e6
      }
    }
    const expected = new Float32Array(81)
    sampleOffset(
      g,
      1,
      [center[0]! * 6.4e6, center[1]! * 6.4e6, center[2]! * 6.4e6],
      local,
      expected,
    )
    expect([...out]).toEqual([...expected])
  })

  it('sampleGrid2d samples the z plane row by row', () => {
    const g = graph({ perlin: {} })
    const out = new Float32Array(12)
    sampleGrid2d(g, 1, { origin: [2, 3], size: [3, 2], resolution: [4, 3] }, out)
    const pts = new Float32Array(36)
    for (let j = 0; j < 3; j++)
      for (let i = 0; i < 4; i++) pts.set([2 + i, 3 + j, 0], (j * 4 + i) * 3)
    const expected = new Float32Array(12)
    sampleNoise(g, 1, pts, expected)
    for (let i = 0; i < 12; i++) expect(out[i]).toBeCloseTo(expected[i]!, 5)
  })
})

describe('worker pool', () => {
  const pool = createNodeWorkers(3)
  afterAll(() => pool.dispose())
  const patch = { face: 4, x0: -1, y0: -1, extent: 2, resolution: 65, radius: 1000 }

  it('pool, inline, and sync sampling give the same values', async () => {
    const g = NoiseGraph.fromJson(PLANET)
    const sync = new Float32Array(65 * 65)
    sampleSpherePatch(g, 8, patch, sync)
    const pooled = new Float32Array(65 * 65)
    await sampleSpherePatchAsync(pool, g, 8, patch, pooled)
    const inline = new Float32Array(65 * 65)
    await sampleSpherePatchAsync(createInlineWorkers(), g, 8, patch, inline)
    expect(checksum(pooled)).toBe(checksum(sync))
    expect(checksum(inline)).toBe(checksum(sync))

    const grid = { origin: [-3, 4] as [number, number], size: 10, resolution: 40 }
    const a = new Float32Array(1600)
    const b = new Float32Array(1600)
    sampleGrid2d(g, 2, grid, a)
    await sampleGrid2dAsync(pool, g, 2, grid, b)
    expect(checksum(b)).toBe(checksum(a))

    const pts = randomPoints(1000, 3, 10)
    const c = new Float32Array(1000)
    const d = new Float32Array(1000)
    sampleOffset(g, 4, [1e6, 2, 3], pts, c)
    await sampleNoiseAsync(pool, g, 4, pts, d, { origin: [1e6, 2, 3] })
    expect(checksum(d)).toBe(checksum(c))
  })

  it('results never depend on which worker ran a job or when it finished', async () => {
    const g = NoiseGraph.fromJson(PLANET)
    const runs = await Promise.all(
      [0, 1, 2, 3, 4, 5].map(async () => {
        const out = new Float32Array(65 * 65)
        await sampleSpherePatchAsync(pool, g, 8, patch, out)
        return checksum(out)
      }),
    )
    expect(new Set(runs).size).toBe(1)
  })
})

describe('allocation', () => {
  it('sync sampling allocates nothing once warmed up', async () => {
    const g = NoiseGraph.fromJson(PLANET)
    const pts = randomPoints(256, 3, 10)
    const out = new Float32Array(256)
    const patch = { face: 0, x0: 0, y0: 0, extent: 0.01, resolution: 33, radius: 6e6 }
    const patchOut = new Float32Array(33 * 33)
    const origin = new Float64Array([6e6, 1, 2])
    const run = () => {
      for (let i = 0; i < 200; i++) {
        sampleNoise(g, i, pts, out)
        sampleOffset(g, i, origin, pts, out)
        sampleSpherePatch(g, i, patch, patchOut)
      }
    }
    run()
    expect(globalThis.gc, 'run with --expose-gc').toBeTypeOf('function')
    globalThis.gc!()
    await new Promise((r) => setTimeout(r, 100))
    const gcs = gcWindow()
    run()
    const collections = await gcs.end()
    if (allocationChecks) expect(collections).toBe(0)
    expect(noiseKernel().simd).toBe(true)
  })
})

/** Checksum of the planet graph at seed 42 over the fixed test points. */
const GOLDEN_PLANET = 'f38c31a8'
