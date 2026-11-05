import { loadNoiseKernel, NoiseGraph } from '@aethervtt/shard-noise'
import { TerrainBudget, terrainEditor } from '@aethervtt/shard-terrain'
import {
  EDIT_HILLS,
  editSource,
  heightfieldApp,
  untilStreaming,
} from '@aethervtt/shard-terrain/testing'
import { Transform } from '@aethervtt/shard-transform'
import { describe, expect, it } from 'vitest'
import { WaterBodies } from './bodies'
import { InfoClipmap, levelTexel } from './clipmap'
import { WaterBody, WaterSpline } from './components'
import { waterOptics } from './optics'
import { waterPlugin } from './plugin'
import { waterAt, waterSample } from './query'
import { INFO_SIZE } from './shaders'

const ring = (r: number, cx: number, cz: number, n = 16) =>
  Array.from({ length: n }, (_, i) => ({
    position: [
      cx + r * Math.cos((i / n) * 2 * Math.PI),
      0,
      cz + r * Math.sin((i / n) * 2 * Math.PI),
    ] as [number, number, number],
    width: 0,
    depth: 0,
    flow: 0,
  }))

describe('water over an edited terrain (0097, 0104)', () => {
  it('reads the new ground under a lake within two frames: waterAt and the info clipmap', async () => {
    await loadNoiseKernel()
    const hills = await NoiseGraph.create(EDIT_HILLS)
    const p = await heightfieldApp(undefined, {
      ...editSource(),
      noise: { hills },
      block: 4,
      extra: [waterPlugin()],
    })
    await untilStreaming(p)
    const w = p.world
    // Correctness: every queued leaf in one frame (the terrain's bench holds TerrainBudget.editMs).
    w.resource(TerrainBudget).editMs = Number.POSITIVE_INFINITY
    w.spawn(
      [WaterBody, { kind: 'lake', optics: waterOptics('lake') }],
      [WaterSpline, { points: ring(30, 0, 0), closed: true }],
      [Transform, { translation: [300, 8, 300] }],
    )
    p.app.update(1 / 60)
    const state = w.resource(WaterBodies)
    const clip = new InfoClipmap()
    // Fill level 0 around the lake.
    for (let f = 0; f < 4; f++) clip.update(state, 300, 300)
    const t = levelTexel(0)
    const texel = (x: number, z: number) => {
      const cx = Math.floor(x / t)
      const cz = Math.floor(z / t)
      const i =
        (((cz % INFO_SIZE) + INFO_SIZE) % INFO_SIZE) * INFO_SIZE +
        (((cx % INFO_SIZE) + INFO_SIZE) % INFO_SIZE)
      return clip.ground[0]![i]!
    }
    const s = waterSample()
    waterAt(w, [302, 0, 302], s)
    const before = s.groundHeight
    const texelBefore = texel(302, 302)
    expect(Math.abs(texelBefore - before)).toBeLessThan(0.5)
    // Dig a 6 m pit under the lake.
    terrainEditor(w, p.terrain).shape({
      shape: { circle: { at: [300, 300], radius: 12 } },
      lower: 6,
    })
    p.app.update(1 / 60)
    p.app.update(1 / 60)
    waterAt(w, [302, 0, 302], s)
    expect(s.groundHeight).toBeCloseTo(before - 6, 1)
    clip.update(state, 300, 300)
    expect(texel(302, 302)).toBeLessThan(texelBefore - 5)
  }, 120_000)
})
