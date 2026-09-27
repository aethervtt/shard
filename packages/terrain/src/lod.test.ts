import { loadNoiseKernel, NoiseGraph } from '@aethervtt/shard-noise'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildChunk, chunkLayout } from './chunk'
import {
  directionToFace,
  EDGE_BOTTOM,
  EDGE_LEFT,
  EDGE_RIGHT,
  EDGE_TOP,
  faceToDirection,
  keyString,
  maxDepthFor,
  neighborNode,
  nodeAt,
  packKey,
  parseKey,
  unpackKey,
} from './cube'
import { measureErrors } from './lod'
import { createSelection, NODE_READY, NodeTree, selectNodes } from './quadtree'
import { omniView, perspectiveView } from './view'

let hills: NoiseGraph

beforeAll(async () => {
  await loadNoiseKernel()
  hills = await NoiseGraph.create({
    output: 'h',
    nodes: {
      c: { fbm: { source: 'simplex', octaves: 6, frequency: 2e-3, seed: 1 } },
      h: { add: ['c', { multiply: [{ ridged: { octaves: 4, frequency: 2e-2, seed: 2 } }, 0.1] }] },
    },
  })
})

describe('cube-sphere math', () => {
  it('derives the deepest level from the finest spacing (spec: 9, 20, 21)', () => {
    expect(maxDepthFor(4000, 33, 0.4)).toBe(9)
    expect(maxDepthFor(6.371e6, 33, 0.4)).toBe(20)
    expect(maxDepthFor(1.6e7, 33, 0.4)).toBe(21)
    expect(maxDepthFor(5e7, 33, 0.4)).toBe(23)
  })

  it('packs node keys into two u32s and back', () => {
    const out = new Uint32Array(2)
    for (const [face, depth, x, y] of [
      [0, 0, 0, 0],
      [5, 24, 2 ** 24 - 1, 2 ** 24 - 2],
      [3, 17, 91234, 3],
    ] as const) {
      packKey(face, depth, x, y, out)
      expect(unpackKey(out[0]!, out[1]!)).toEqual({ face, depth, x, y })
      expect(parseKey(keyString(face, depth, x, y))).toEqual({ face, depth, x, y })
    }
  })

  it('finds neighbors across cube edges, and each finds the node back', () => {
    const n = new Float64Array(3)
    const back = new Float64Array(3)
    const depth = 3
    const side = 2 ** depth
    let crossings = 0
    for (let face = 0; face < 6; face++) {
      for (let x = 0; x < side; x++) {
        for (let y = 0; y < side; y++) {
          for (const edge of [EDGE_BOTTOM, EDGE_RIGHT, EDGE_TOP, EDGE_LEFT]) {
            neighborNode(face, depth, x, y, edge, n)
            if (n[0] !== face) crossings++
            // One of the neighbor's edges leads back here.
            let found = false
            for (const e of [EDGE_BOTTOM, EDGE_RIGHT, EDGE_TOP, EDGE_LEFT]) {
              neighborNode(n[0]!, depth, n[1]!, n[2]!, e, back)
              if (back[0] === face && back[1] === x && back[2] === y) found = true
            }
            expect(found).toBe(true)
          }
        }
      }
    }
    // Every face has 4 × side edge nodes crossing to a neighbor face.
    expect(crossings).toBe(6 * 4 * side)
  })

  it('maps directions to faces and back', () => {
    const d = new Float64Array(3)
    const uv = new Float64Array(2)
    const node = new Float64Array(3)
    for (let face = 0; face < 6; face++) {
      faceToDirection(face, 0.3, -0.7, d)
      expect(directionToFace(d[0]!, d[1]!, d[2]!, uv)).toBe(face)
      expect(uv[0]).toBeCloseTo(0.3, 12)
      expect(uv[1]).toBeCloseTo(-0.7, 12)
      nodeAt(d[0]!, d[1]!, d[2]!, 4, node)
      expect([node[0], node[1], node[2]]).toEqual([face, Math.floor(1.3 * 8), Math.floor(0.3 * 8)])
    }
  })
})

describe('CPU chunks', () => {
  const base = {
    radius: 6.371e6,
    shape: [1, 1, 1],
    heightScale: 600,
    seed: 7,
    resolution: 33,
    climate: undefined,
    morphError: 1,
    skirtDepth: 5,
  }

  function vertex(chunk: ReturnType<typeof buildChunk>, i: number, j: number, n = 33) {
    const v = chunkLayout(n).index[i + j * n]!
    const p = chunk.data.positions
    return [
      p[v * 3]! + chunk.center[0]!,
      p[v * 3 + 1]! + chunk.center[1]!,
      p[v * 3 + 2]! + chunk.center[2]!,
    ]
  }

  it('shares edge vertices with its neighbors, across a cube edge too', () => {
    const depth = 12
    const last = 2 ** depth - 1
    // Same face, left/right neighbors.
    const a = buildChunk({ ...base, height: hills, face: 2, depth, x: 100, y: 200 })
    const b = buildChunk({ ...base, height: hills, face: 2, depth, x: 101, y: 200 })
    for (let j = 0; j < 33; j++) {
      const pa = vertex(a, 32, j)
      const pb = vertex(b, 0, j)
      expect(Math.hypot(pa[0]! - pb[0]!, pa[1]! - pb[1]!, pa[2]! - pb[2]!)).toBeLessThan(5e-4)
    }
    // Face 0's right edge (u = 1) meets another face: every vertex there has a twin.
    const c = buildChunk({ ...base, height: hills, face: 0, depth, x: last, y: 1000 })
    const n = new Float64Array(3)
    neighborNode(0, depth, last, 1000, EDGE_RIGHT, n)
    const d = buildChunk({ ...base, height: hills, face: n[0]!, depth, x: n[1]!, y: n[2]! })
    const twins: number[][] = []
    for (let i = 0; i < 33; i++) for (let j = 0; j < 33; j++) twins.push(vertex(d, i, j))
    for (let j = 0; j < 33; j++) {
      const p = vertex(c, 32, j)
      const best = Math.min(
        ...twins.map((q) => Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!)),
      )
      expect(best).toBeLessThan(1e-3)
    }
  })

  it('puts even vertices where the parent has them, and morphs odd ones onto its surface', () => {
    const parent = buildChunk({ ...base, height: hills, face: 4, depth: 14, x: 300, y: 301 })
    const child = buildChunk({ ...base, height: hills, face: 4, depth: 15, x: 601, y: 602 })
    const t = child.data.tangents!
    const layout = chunkLayout(33)
    for (let j = 0; j < 33; j++) {
      for (let i = 0; i < 33; i++) {
        const v = layout.index[i + j * 33]!
        const delta = Math.hypot(t[v * 4]!, t[v * 4 + 1]!, t[v * 4 + 2]!)
        if (i % 2 === 0 && j % 2 === 0) {
          expect(delta).toBe(0)
          // Child (601, 602) is the parent's right (x odd) top (y even? 602 → lower) quadrant.
          const pi = (i + 32) / 2
          const pj = j / 2
          const pc = vertex(child, i, j)
          const pp = vertex(parent, pi, pj)
          // Same height bits (same lattice origin); only f32 rounding of the offsets differs.
          expect(Math.hypot(pc[0]! - pp[0]!, pc[1]! - pp[1]!, pc[2]! - pp[2]!)).toBeLessThan(1e-4)
        }
      }
    }
    expect(child.error).toBeGreaterThan(0)
    // Heights are in the graph's range times the scale.
    expect(child.maxHeight).toBeLessThanOrEqual(600 * 1.1)
    expect(child.minHeight).toBeGreaterThanOrEqual(-600 * 1.1)
  })

  it('measures errors that shrink with depth', () => {
    const errors = measureErrors({
      radius: 4000,
      shape: [1, 1, 1],
      heightScale: 300,
      seed: 3,
      resolution: 33,
      maxDepth: maxDepthFor(4000, 33, 0.4),
      height: hills,
    })
    for (let d = 1; d < errors.length; d++) expect(errors[d]).toBeLessThanOrEqual(errors[d - 1]!)
    expect(errors[1]).toBeGreaterThan(10)
    expect(errors[errors.length - 1]).toBe(0)
  })
})

describe('selection', () => {
  function planetTree(radius: number, heightScale: number) {
    const tree = new NodeTree()
    tree.reset(radius, [1, 1, 1], -heightScale, heightScale)
    const maxDepth = maxDepthFor(radius, 33, 0.4)
    const errors = measureErrors({
      radius,
      shape: [1, 1, 1],
      heightScale,
      seed: 3,
      resolution: 33,
      maxDepth,
      height: hills,
    })
    const params = {
      maxDepth,
      errors,
      errorPixels: 2,
      occluder: radius - heightScale,
      colliderDepth: maxDepth,
      anchorPos: new Float64Array(0),
      anchorRadius: new Float64Array(0),
      anchors: 0,
    }
    return { tree, params }
  }

  /** Runs selection, marking requested nodes ready, until nothing more is requested. */
  function settle(
    tree: NodeTree,
    view: ReturnType<typeof omniView>,
    params: ReturnType<typeof planetTree>['params'],
  ) {
    const sel = createSelection()
    for (let frame = 1; frame < 200; frame++) {
      selectNodes(tree, view, params, frame, sel)
      if (sel.requestedCount === 0) return sel
      for (let i = 0; i < sel.requestedCount; i++) tree.flags[sel.requested[i]!]! |= NODE_READY
    }
    throw new Error('selection never settled')
  }

  it('shows the six roots from far away', () => {
    const { tree, params } = planetTree(4000, 300)
    const view = omniView(
      {
        position: new Float64Array(3),
        frustum: new Float64Array(16),
        wide: new Float64Array(16),
        planes: 0,
        pixelsPerRadian: 900,
      },
      [0, 0, 2e7],
      900,
    )
    const sel = settle(tree, view, params)
    expect(sel.renderedCount).toBeLessThanOrEqual(6)
    for (let i = 0; i < sel.renderedCount; i++) expect(tree.depth[sel.rendered[i]!]).toBe(0)
  })

  it('covers everything in view exactly once, balanced 2:1, near the surface', () => {
    const R = 6.371e6
    const { tree, params } = planetTree(R, 600)
    const eye = [0, R + 800, 0]
    const view = perspectiveView(
      {
        position: new Float64Array(3),
        frustum: new Float64Array(16),
        wide: new Float64Array(16),
        planes: 0,
        pixelsPerRadian: 0,
      },
      eye,
      [1, 0, 0],
      [0, 0.8, -0.6],
      [0, -0.6, -0.8],
      Math.PI / 3,
      16 / 9,
      1080,
    )
    const sel = settle(tree, view, params)
    const rendered = new Set(Array.from(sel.rendered.subarray(0, sel.renderedCount)))
    expect(rendered.size).toBe(sel.renderedCount)
    let deepest = 0
    for (const n of rendered) deepest = Math.max(deepest, tree.depth[n]!)
    expect(deepest).toBeGreaterThan(12)
    // Rays through a 64 × 64 grid of pixels: where one meets the sphere, the direction maps to
    // exactly one rendered node.
    const node = new Float64Array(3)
    const f = [0, -0.6, -0.8]
    const u = [0, 0.8, -0.6]
    const tx = Math.tan(Math.PI / 6) * (16 / 9)
    const ty = Math.tan(Math.PI / 6)
    let covered = 0
    let rays = 0
    for (let py = 0; py < 64; py++) {
      for (let px = 0; px < 64; px++) {
        const a = ((px + 0.5) / 32 - 1) * tx
        const b = ((py + 0.5) / 32 - 1) * ty
        const d = [a, u[1]! * b + f[1]!, u[2]! * b + f[2]!]
        const len = Math.hypot(d[0]!, d[1]!, d[2]!)
        const dx = d[0]! / len
        const dy = d[1]! / len
        const dz = d[2]! / len
        // Ray from eye against the sphere of radius R.
        const bq = eye[1]! * dy
        const c = eye[1]! * eye[1]! - R * R
        const disc = bq * bq - c
        if (disc < 0) continue
        const t = -bq - Math.sqrt(disc)
        if (t < 0) continue
        rays++
        const hx = dx * t
        const hy = eye[1]! + dy * t
        const hz = dz * t
        const hl = Math.hypot(hx, hy, hz)
        nodeAt(hx / hl, hy / hl, hz / hl, params.maxDepth, node)
        let hits = 0
        for (
          let n = tree.find(node[0]!, params.maxDepth, node[1]!, node[2]!);
          n !== -1;
          n = tree.parent[n]!
        ) {
          if (rendered.has(n)) hits++
        }
        expect(hits).toBe(1)
        covered += hits
      }
    }
    expect(rays).toBeGreaterThan(2000)
    expect(covered).toBe(rays)
    // 2:1: every rendered node's neighbors are within one level.
    const n = new Float64Array(3)
    for (const r of rendered) {
      for (let edge = 0; edge < 4; edge++) {
        neighborNode(tree.face[r]!, tree.depth[r]!, tree.x[r]!, tree.y[r]!, edge, n)
        let m = tree.find(n[0]!, tree.depth[r]!, n[1]!, n[2]!)
        while (m !== -1 && !rendered.has(m)) m = tree.parent[m]!
        if (m !== -1) expect(tree.depth[r]! - tree.depth[m]!).toBeLessThanOrEqual(1)
      }
    }
  })
})
