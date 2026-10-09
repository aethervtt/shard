import { type Entity, ShardError, type World } from '@aethervtt/shard-core'
import { TerrainWorld } from '../heights'
import { dequantize, LEAF_SIDE, PAGE, SIDE } from './kernel'
import { type LoadedPage, nodeKey } from './pages'
import type { HeightfieldRuntime } from './runtime'

/** What `terrainHeightAt` found. */
export interface TerrainHeight {
  /** Metres, in the terrain's frame (its corner at 0). */
  height: number
  /** The depth of the page it came from (the leaf depth is exact). */
  depth: number
  /** Whether that's the leaf depth: the collider's own surface. */
  exact: boolean
}

/** The heightfield runtime of a Terrain entity, ready for queries, or a `terrain/*` error. */
export function heightfieldRuntime(world: World, terrain: Entity): HeightfieldRuntime {
  const rt = world.tryResource(TerrainWorld)?.heightfields.get(terrain)
  if (!rt) {
    throw new ShardError('terrain/not-a-terrain', `Entity ${terrain} has no terrain/Terrain`, {
      hint: 'Add terrain/Terrain (with a Grid) to the entity, and the terrain plugin to the app.',
    })
  }
  if (rt.problem) throw rt.problem
  if (!rt.ready || !rt.pages) {
    throw new ShardError(
      'terrain/not-ready',
      `Terrain ${terrain} is waiting for ${rt.waiting ?? 'its source'}`,
      {
        hint: 'Its source and assets load asynchronously; step a frame (or await them) first.',
      },
    )
  }
  return rt
}

/** The finest page held on the CPU that covers (x, z), deepest first. */
export function finestPage(rt: HeightfieldRuntime, x: number, z: number): LoadedPage | undefined {
  const layout = rt.layout!
  if (x < 0 || z < 0 || x > layout.sizeX || z > layout.sizeZ) return undefined
  for (let depth = layout.depth; depth >= 0; depth--) {
    const size = rt.nodeSize(depth)
    const [nx, nz] = rt.pages!.nodesAt(depth)
    const px = Math.min(nx - 1, Math.floor(x / size))
    const pz = Math.min(nz - 1, Math.floor(z / size))
    const page = rt.pages!.get(nodeKey(depth, px, pz))
    if (page) return page
  }
  return undefined
}

/** The page's sample (i, j) in metres. */
function sample(rt: HeightfieldRuntime, page: LoadedPage, i: number, j: number): number {
  const side = page.leaf ? LEAF_SIDE : SIDE
  const o = page.leaf ? 1 : 0
  return dequantize(page.heights[(j + o) * side + i + o]!, rt.lo, rt.hi)
}

/**
 * The page's surface at (x, z): its cell's triangle split along (i+1, j)–(i, j+1), as the mesh and
 * Rapier's heightfield are.
 */
export function pageHeight(rt: HeightfieldRuntime, page: LoadedPage, x: number, z: number): number {
  const size = rt.nodeSize(page.depth)
  const fx = ((x - page.x * size) / size) * PAGE
  const fz = ((z - page.z * size) / size) * PAGE
  const i = Math.min(PAGE - 1, Math.max(0, Math.floor(fx)))
  const j = Math.min(PAGE - 1, Math.max(0, Math.floor(fz)))
  const u = Math.min(1, Math.max(0, fx - i))
  const v = Math.min(1, Math.max(0, fz - j))
  const h00 = sample(rt, page, i, j)
  const h10 = sample(rt, page, i + 1, j)
  const h01 = sample(rt, page, i, j + 1)
  const h11 = sample(rt, page, i + 1, j + 1)
  return u + v <= 1
    ? h00 + u * (h10 - h00) + v * (h01 - h00)
    : h11 + (1 - u) * (h01 - h11) + (1 - v) * (h10 - h11)
}

/**
 * The ground's height at terrain point (x, z) (spec 0071): sync, from the finest page held on the
 * CPU there (the coarse levels always are), with the depth it used. `loadTerrainRegion` first makes
 * it exact (the leaf depth, the colliders' surface) away from anchors. Throws
 * `terrain/out-of-bounds` off the terrain.
 */
export function terrainHeightAt(
  world: World,
  terrain: Entity,
  x: number,
  z: number,
  out: TerrainHeight = { height: 0, depth: 0, exact: false },
): TerrainHeight {
  const rt = heightfieldRuntime(world, terrain)
  const page = finestPage(rt, x, z)
  if (!page) {
    const l = rt.layout!
    if (x < 0 || z < 0 || x > l.sizeX || z > l.sizeZ) {
      throw new ShardError(
        'terrain/out-of-bounds',
        `(${x}, ${z}) is off the terrain (0–${l.sizeX} × 0–${l.sizeZ} m)`,
        {
          hint: 'Points are metres from the terrain’s corner in its frame.',
        },
      )
    }
    throw new ShardError('terrain/not-ready', 'The terrain’s coarse levels are still loading', {
      hint: 'Step a few frames, or await loadTerrainRegion first.',
    })
  }
  out.height = pageHeight(rt, page, x, z)
  out.depth = page.depth
  out.exact = page.depth === rt.layout!.depth
  return out
}

/**
 * Loads and pins the leaf pages over `rect` ([x0, z0, x1, z1] metres in the terrain's frame), so
 * `terrainHeightAt` there is exact: gameplay that needs the colliders' heights away from anchors
 * (spawn points, say). Resolves with the pages pinned.
 */
export async function loadTerrainRegion(
  world: World,
  terrain: Entity,
  rect: readonly [number, number, number, number],
): Promise<number> {
  const rt = heightfieldRuntime(world, terrain)
  const layout = rt.layout!
  const size = layout.leafSize
  const D = layout.depth
  const x0 = Math.max(0, Math.floor(rect[0] / size))
  const z0 = Math.max(0, Math.floor(rect[1] / size))
  const x1 = Math.min(layout.leavesX - 1, Math.floor(rect[2] / size))
  const z1 = Math.min(layout.leavesZ - 1, Math.floor(rect[3] / size))
  const loads: Promise<unknown>[] = []
  for (let z = z0; z <= z1; z++) {
    for (let x = x0; x <= x1; x++) {
      rt.pages!.pin(nodeKey(D, x, z))
      loads.push(rt.pages!.load(D, x, z))
    }
  }
  await Promise.all(loads)
  return loads.length
}

/** Everything about the ground at a point: what `terrain.sample` reports. */
export interface HeightfieldSample {
  height: number
  /** Unit normal in the terrain's frame. */
  normal: [number, number, number]
  /** Degrees from flat. */
  slope: number
  /** The two heaviest material layers (names) and the second's share of their weight. */
  layers: [string, string]
  share: number
  depth: number
}

/** The ground at (x, z) from the finest page held (leaf pages after `loadTerrainRegion`). */
export function heightfieldSample(rt: HeightfieldRuntime, x: number, z: number): HeightfieldSample {
  const page = finestPage(rt, x, z)
  if (!page) {
    throw new ShardError('terrain/out-of-bounds', `(${x}, ${z}) is off the terrain`, {
      hint: 'Points are metres from the terrain’s corner in its frame.',
    })
  }
  const size = rt.nodeSize(page.depth)
  const fx = ((x - page.x * size) / size) * PAGE
  const fz = ((z - page.z * size) / size) * PAGE
  const i = Math.min(PAGE, Math.max(0, Math.round(fx)))
  const j = Math.min(PAGE, Math.max(0, Math.round(fz)))
  // The normal from the triangle under the point (its exact slope), not the shading normals.
  const spacing = size / PAGE
  const ci = Math.min(PAGE - 1, Math.max(0, Math.floor(fx)))
  const cj = Math.min(PAGE - 1, Math.max(0, Math.floor(fz)))
  const u = fx - ci
  const v = fz - cj
  let dx: number
  let dz: number
  if (u + v <= 1) {
    dx = (sample(rt, page, ci + 1, cj) - sample(rt, page, ci, cj)) / spacing
    dz = (sample(rt, page, ci, cj + 1) - sample(rt, page, ci, cj)) / spacing
  } else {
    dx = (sample(rt, page, ci + 1, cj + 1) - sample(rt, page, ci, cj + 1)) / spacing
    dz = (sample(rt, page, ci + 1, cj + 1) - sample(rt, page, ci + 1, cj)) / spacing
  }
  const l = Math.sqrt(dx * dx + 1 + dz * dz)
  const normal: [number, number, number] = [-dx / l, 1 / l, -dz / l]
  // Paint: the nearest control texel.
  const cells = rt.layout!.cells
  const k = PAGE / cells
  const ci2 = Math.min(cells, Math.max(0, Math.round(i / k)))
  const cj2 = Math.min(cells, Math.max(0, Math.round(j / k)))
  const o = (cj2 * (cells + 1) + ci2) * 4
  const names = rt.asset!.source.layers.map((layer) => layer.name)
  const a = page.control[o]!
  const b = page.control[o + 1]!
  return {
    height: pageHeight(rt, page, x, z),
    normal,
    slope: (Math.acos(Math.min(1, normal[1])) * 180) / Math.PI,
    layers: [names[a] ?? '', names[b] ?? ''],
    share: page.control[o + 2]! / 255,
    depth: page.depth,
  }
}
