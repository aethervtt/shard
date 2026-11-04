import type { World } from '@aethervtt/shard-core'
import { Camera3d, defineOverlay } from '@aethervtt/shard-render'
import { GlobalTransform } from '@aethervtt/shard-transform'
import { type WindSample, windAt, windSample } from './wind'

const GRID = 9
const SPACING = 4
const sample: WindSample = windSample()
const p = new Float64Array(3)
const a = new Float32Array(3)
const b = new Float32Array(3)
const c = new Float32Array(3)
const color = [0, 0, 0, 1]

/** Calm blue, breeze green, gale red: by speed with gusts, in m/s. */
function speedColor(speed: number): number[] {
  const x = Math.min(speed / 18, 1)
  color[0] = x < 0.33 ? 0.2 : Math.min(1, (x - 0.33) * 3)
  color[1] = x < 0.33 ? 0.4 + x * 1.8 : Math.max(0.15, 1 - (x - 0.33) * 1.5)
  color[2] = x < 0.33 ? 1 - x * 2.4 : 0.15
  return color
}

/** Arrows on a grid around the first camera, a metre below it: windAt, coloured by speed. */
export const windOverlay = defineOverlay({
  name: 'wind',
  description:
    'Wind (0096): arrows on a 9×9 grid every 4 m around the camera, a metre below it, pointing downwind, as long as the speed with gusts (a metre per 6 m/s), blue when calm to red in a gale. Shows WindZones at work.',
  draw: (world: World, g) => {
    const cameras = world.query({ with: [Camera3d, GlobalTransform] })
    let cx = 0
    let cy = 0
    let cz = 0
    for (const table of cameras.tables) {
      if (table.count === 0) continue
      const m = table.column(GlobalTransform, 'matrix')
      cx = m[3]!
      cy = m[7]! - 1
      cz = m[11]!
      break
    }
    const half = ((GRID - 1) / 2) * SPACING
    for (let i = 0; i < GRID; i++) {
      for (let j = 0; j < GRID; j++) {
        p[0] = Math.round(cx / SPACING) * SPACING - half + i * SPACING
        p[1] = cy
        p[2] = Math.round(cz / SPACING) * SPACING - half + j * SPACING
        windAt(world, p, sample)
        const speed = Math.max(sample.speed + sample.gust, 0)
        const len = speed / 6
        const d = sample.direction
        a[0] = p[0]!
        a[1] = p[1]!
        a[2] = p[2]!
        b[0] = a[0] + d[0] * len
        b[1] = a[1] + d[1] * len
        b[2] = a[2] + d[2] * len
        const rgba = speedColor(speed)
        g.line(a, b, rgba)
        if (len < 0.05) continue
        // A head: two short strokes back from the tip, either side (horizontal).
        for (const side of [1, -1]) {
          c[0] = b[0] - (d[0] - side * d[2] * 0.5) * len * 0.25
          c[1] = b[1] - d[1] * len * 0.25
          c[2] = b[2] - (d[2] + side * d[0] * 0.5) * len * 0.25
          g.line(b, c, rgba)
        }
      }
    }
  },
})
