import type { World } from '@aethervtt/shard-core'
import type { CaptureDebugView } from '@aethervtt/shard-protocol'
import { Gpu, readTextureLayer } from '@aethervtt/shard-render'
import { WaterRender } from './render'
import { INFO_LEVELS, INFO_SIZE } from './shaders'

/**
 * The info texture's levels as floats (surface, ground, flow x, flow z per texel), level by level:
 * what the surface reads. For tests and `render.capture { debug: 'water-info' }`.
 */
export async function readWaterInfo(world: World): Promise<Float32Array[]> {
  const render = world.tryResource(WaterRender)
  const gpu = world.tryResource(Gpu)
  if (!render || !gpu || render.gpu.generation !== gpu.generation) return []
  const out: Float32Array[] = []
  for (let l = 0; l < INFO_LEVELS; l++)
    out.push((await readTextureLayer(gpu, render.gpu.info, l)).data)
  return out
}

/**
 * `render.capture { debug: 'water-info' }`: the clipmap's four levels in a 2×2 grid (level 0 top
 * left, then right, then the bottom row), 256 px each, north (−z) up. Water is blue, darker where
 * deeper over the ground (cyan where the ground is unknown); dry texels are the ground in grey,
 * black where none is known.
 */
export const waterInfoView: CaptureDebugView = {
  description: "The water's info texture: surface and ground per clipmap level.",
  capture: async (world) => {
    const levels = await readWaterInfo(world)
    const side = INFO_SIZE * 2
    const data = new Uint8Array(side * side * 4)
    for (let l = 0; l < levels.length; l++) {
      const f = levels[l]!
      let lo = Infinity
      let hi = -Infinity
      for (let i = 0; i < INFO_SIZE * INFO_SIZE; i++) {
        const g = f[i * 4 + 1]!
        if (g > -1e8) {
          lo = Math.min(lo, g)
          hi = Math.max(hi, g)
        }
      }
      const range = Math.max(hi - lo, 1e-3)
      const x0 = (l % 2) * INFO_SIZE
      const y0 = Math.floor(l / 2) * INFO_SIZE
      for (let y = 0; y < INFO_SIZE; y++) {
        for (let x = 0; x < INFO_SIZE; x++) {
          const i = (y * INFO_SIZE + x) * 4
          const surface = f[i]!
          const ground = f[i + 1]!
          const o = ((y0 + y) * side + x0 + x) * 4
          data[o + 3] = 255
          if (surface > -1e8) {
            if (ground > -1e8) {
              const t = Math.exp(-Math.max(0, surface - ground) / 8)
              data[o] = Math.round(20 + 60 * t)
              data[o + 1] = Math.round(40 + 160 * t)
              data[o + 2] = Math.round(120 + 135 * t)
            } else {
              data[o] = 40
              data[o + 1] = 200
              data[o + 2] = 230
            }
          } else if (ground > -1e8) {
            const v = Math.round(60 + 160 * ((ground - lo) / range))
            data[o] = v
            data[o + 1] = v
            data[o + 2] = v
          }
        }
      }
    }
    return { width: side, height: side, data }
  },
}
