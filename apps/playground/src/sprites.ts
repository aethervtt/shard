import { defineSystem, Rng, Update } from '@aethervtt/shard-core'
import { Camera3d, Tonemapping } from '@aethervtt/shard-render'
import { definePlugin, Time } from '@aethervtt/shard-runtime'
import { Sprite, TextureAtlas, TextureAtlases } from '@aethervtt/shard-sprite'
import { Texture, Textures } from '@aethervtt/shard-texture'
import { Transform } from '@aethervtt/shard-transform'

/** A 64×64 atlas of 16 shapes (discs, rings, diamonds) in one hue, made in code. */
function atlasTexture(hue: number): Texture {
  const size = 64
  const data = new Uint8Array(size * size * 4)
  for (let cell = 0; cell < 16; cell++) {
    const ox = (cell % 4) * 16
    const oy = Math.floor(cell / 4) * 16
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const dx = x - 7.5
        const dy = y - 7.5
        const r = Math.sqrt(dx * dx + dy * dy)
        const kind = cell % 3
        const inside =
          kind === 0 ? r < 7 : kind === 1 ? r < 7 && r > 4 : Math.abs(dx) + Math.abs(dy) < 7.5
        const shade = 0.55 + 0.45 * (cell / 15)
        const o = ((oy + y) * size + ox + x) * 4
        data[o] = Math.round(255 * shade * (0.5 + 0.5 * Math.cos(hue)))
        data[o + 1] = Math.round(255 * shade * (0.5 + 0.5 * Math.cos(hue - 2.1)))
        data[o + 2] = Math.round(255 * shade * (0.5 + 0.5 * Math.cos(hue + 2.1)))
        data[o + 3] = inside ? 255 : 0
      }
    }
  }
  return Texture.create({ width: size, height: size, mips: [data] })
}

const drift = defineSystem({
  name: 'sprites-demo/pan',
  setup: (world) => ({ q: world.query({ with: [Camera3d, Transform] }) }),
  run: ({ q }, world) => {
    const t = world.resource(Time).elapsed
    for (const table of q.tables) {
      const tr = table.column(Transform, 'translation')
      for (let i = 0; i < table.count; i++) {
        tr[i * 3] = Math.sin(t * 0.3) * 20
        tr[i * 3 + 1] = Math.cos(t * 0.2) * 12
      }
      table.markChanged(Transform)
    }
  },
})

/**
 * 100k static sprites from 4 atlases, one layer each, under a panning 2D camera. `?count=` sets
 * the number. Static sprites upload nothing after the first frame; the pan only moves the camera.
 */
export const spritesPlugin = definePlugin({
  name: 'sprites-demo',
  dependencies: ['sprite'],
  build(app) {
    app.addSystems(Update, drift)
  },
  ready(app) {
    const world = app.world
    const count = Number(new URLSearchParams(location.search).get('count') ?? 100_000)
    world.spawn(
      [
        Camera3d,
        { projection: 'orthographic', orthoHeight: 60, clearColor: [0.02, 0.02, 0.04, 1] },
      ],
      [Tonemapping, { curve: 'none' }],
      [Transform, { translation: [0, 0, 100] }],
    )
    const textures = world.resource(Textures)
    const atlases = world.resource(TextureAtlases)
    const regions = Array.from({ length: 16 }, (_, i) => ({
      name: `shape${i}`,
      rect: [(i % 4) * 16, Math.floor(i / 4) * 16, 16, 16],
    }))
    const refs = [0, 1.6, 3.2, 4.8].map((hue) =>
      atlases.add(new TextureAtlas(textures.add(atlasTexture(hue)) as never, regions)),
    )
    const rng = new Rng(9)
    for (let i = 0; i < count; i++) {
      const s = rng.range(0.4, 1.4)
      world.spawn(
        [
          Sprite,
          {
            atlas: refs[i % 4]!,
            region: `shape${rng.int(0, 15)}`,
            size: [s, s],
            layer: i % 4,
            color: [1, 1, 1, rng.range(0.6, 1)],
          },
        ],
        [Transform, { translation: [rng.range(-120, 120), rng.range(-70, 70), rng.range(0, 1)] }],
      )
    }
  },
})
