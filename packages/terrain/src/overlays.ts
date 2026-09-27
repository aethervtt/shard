import { defineOverlay } from '@aethervtt/shard-render'
import { chunkLayout } from './chunk'
import { collidersOf } from './colliders'
import { Terrain } from './heights'

/** Chunk shading by depth: what `terrain-lod` turns on (the material's debug mode 3). */
export const terrainLodOverlay = defineOverlay({
  name: 'terrain-lod',
  description:
    'Planet terrain shaded by LOD depth (a hue per level, darker toward edges locked to a coarser neighbor), to see where chunks split.',
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
    'Planet collider chunks: each one’s border on the surface (green; yellow while cached but not in use), and a circle per anchor showing the radius it keeps colliders within.',
  draw: (world, g) => {
    const state = world.tryResource(Terrain)
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
  },
})
