import { defineOverlay } from '@aethervtt/shard-render'
import { collidersOf } from './colliders'
import { chunkLayout } from './grid-mesh'
import { tilesOf } from './heightfield/colliders'
import { TerrainWorld } from './heights'

/** Chunk shading by depth: what `terrain-lod` turns on (the material's debug mode 3). */
export const terrainLodOverlay = defineOverlay({
  name: 'terrain-lod',
  description:
    'Terrain (planets and heightfields) shaded by LOD depth (a hue per level), to see where chunks split.',
  draw: () => {},
})

/** Heightfield chunks shaded by the page each draws, with page streaming in the colliders' colors. */
export const terrainPagesOverlay = defineOverlay({
  name: 'terrain-pages',
  description:
    'Heightfield terrain (0071) shaded by the GPU pool page each chunk draws (a hue per slot): pages arriving show as new hues, coarse resident pages as the large patches. terrain.describe lists resident pages and reads in flight.',
  draw: () => {},
})

/** Chunk shading by dominant biome: what `terrain-biomes` turns on (debug mode 1). */
export const terrainBiomesOverlay = defineOverlay({
  name: 'terrain-biomes',
  description: 'Planet terrain shaded flat by its dominant biome’s tint, without textures.',
  draw: () => {},
})

const COLLIDER = [0.2, 1, 0.4, 1]
const PENDING = [1, 0.8, 0.2, 1]
const ANCHOR = [0.3, 0.7, 1, 1]
const a = new Float64Array(3)
const b = new Float64Array(3)

/** Collider chunks (their borders, on the surface) and the anchors that keep them. */
export const terrainCollidersOverlay = defineOverlay({
  name: 'terrain-colliders',
  description:
    'Collider chunks (planets) and tiles (heightfields): each one’s border on the ground (green; yellow while cached but not in use), and a circle per anchor showing the radius it keeps colliders within.',
  draw: (world, g) => {
    const state = world.tryResource(TerrainWorld)
    if (!state) return
    for (const rt of state.planets.values()) {
      if (!rt.ready) continue
      const layout = chunkLayout(rt.settings!.resolution)
      const rp = layout.ringPoints
      for (const chunk of collidersOf(rt).chunks.values()) {
        const m = chunk.mesh
        const p = m.data.positions
        const color = chunk.entity >= 0 ? COLLIDER : PENDING
        for (let r = 0; r < layout.ring; r++) {
          const s = (r + 1) % layout.ring
          const va = layout.index[rp[r * 2]! + rp[r * 2 + 1]! * layout.resolution]!
          const vb = layout.index[rp[s * 2]! + rp[s * 2 + 1]! * layout.resolution]!
          rt.frame.pointToOrigin(
            p[va * 3]! + m.center[0]!,
            p[va * 3 + 1]! + m.center[1]!,
            p[va * 3 + 2]! + m.center[2]!,
            a,
          )
          rt.frame.pointToOrigin(
            p[vb * 3]! + m.center[0]!,
            p[vb * 3 + 1]! + m.center[1]!,
            p[vb * 3 + 2]! + m.center[2]!,
            b,
          )
          g.line(a, b, color)
        }
      }
      for (let i = 0; i < rt.anchors; i++) {
        const o = i * 3
        rt.frame.pointToOrigin(rt.anchorPos[o]!, rt.anchorPos[o + 1]!, rt.anchorPos[o + 2]!, a)
        g.sphere(a, rt.anchorRadius[i]!, ANCHOR)
      }
    }
    // Heightfield collider tiles (0071): each tile's border along its heights.
    for (const rt of state.heightfields.values()) {
      if (!rt.ready || !rt.layout) continue
      const size = rt.layout.leafSize
      const n = 65
      for (const tile of tilesOf(rt).tiles.values()) {
        const color = tile.entity >= 0 ? COLLIDER : PENDING
        const x0 = tile.x * size
        const z0 = tile.z * size
        const point = (i: number, j: number, out: Float64Array) =>
          rt.frame.pointToOrigin(
            x0 + (i / (n - 1)) * size,
            tile.heights[j * n + i]! + 0.05,
            z0 + (j / (n - 1)) * size,
            out,
          )
        for (let k = 0; k < n - 1; k += 4) {
          const k1 = Math.min(n - 1, k + 4)
          for (const [i0, j0, i1, j1] of [
            [k, 0, k1, 0],
            [k, n - 1, k1, n - 1],
            [0, k, 0, k1],
            [n - 1, k, n - 1, k1],
          ] as const) {
            point(i0, j0, a)
            point(i1, j1, b)
            g.line(a, b, color)
          }
        }
      }
      for (let i = 0; i < rt.anchors; i++) {
        const o = i * 3
        rt.frame.pointToOrigin(rt.anchorPos[o]!, rt.anchorPos[o + 1]!, rt.anchorPos[o + 2]!, a)
        g.sphere(a, rt.anchorRadius[i]!, ANCHOR)
      }
    }
  },
})
