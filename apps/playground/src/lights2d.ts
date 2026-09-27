import { defineSystem, type Entity, quat, Rng, Update, type World } from '@aethervtt/shard-core'
import {
  Camera3d,
  DebugOverlays,
  isOverlayOn,
  setOverlays,
  Tonemapping,
} from '@aethervtt/shard-render'
import { definePlugin, Time } from '@aethervtt/shard-runtime'
import {
  describeLights2d,
  Lighting2d,
  LightOccluder2d,
  PointLight2d,
  SpotLight2d,
  Sprite,
  SpriteLighting,
  TextureAtlas,
  TextureAtlases,
  Tilemap,
  TilemapData,
  TilemapDatas,
} from '@aethervtt/shard-sprite'
import { Texture, Textures } from '@aethervtt/shard-texture'
import { Transform } from '@aethervtt/shard-transform'
import { hudExtras } from './hud'

/** The dungeon: 64 × 40 tiles of half a unit, centered on the origin. */
const MAP_W = 64
const MAP_H = 40
const TILE = 0.5
const ORIGIN_X = -(MAP_W * TILE) / 2
const ORIGIN_Y = (MAP_H * TILE) / 2
type Rgba = [number, number, number, number]
const NIGHT: Rgba = [0.03, 0.035, 0.06, 1]
const DUSK: Rgba = [0.35, 0.3, 0.4, 1]

type Rgb = [number, number, number]

/** RGBA8 pixels plus a matching normal map (tangent space, +Y up), drawn cell by cell. */
class Sheet {
  readonly w: number
  readonly h: number
  readonly albedo: Uint8Array
  readonly normal: Uint8Array

  constructor(w: number, h: number) {
    this.w = w
    this.h = h
    this.albedo = new Uint8Array(w * h * 4)
    this.normal = new Uint8Array(w * h * 4)
    for (let p = 0; p < w * h; p++) this.normal.set([128, 128, 255, 255], p * 4)
  }

  put(x: number, y: number, c: Rgb, a: number, n: [number, number, number]): void {
    const o = (y * this.w + x) * 4
    this.albedo.set([c[0], c[1], c[2], a], o)
    const l = Math.hypot(n[0], n[1], n[2]) || 1
    this.normal.set(
      [
        Math.round((n[0] / l) * 127.5 + 127.5),
        Math.round((n[1] / l) * 127.5 + 127.5),
        Math.round((n[2] / l) * 127.5 + 127.5),
        255,
      ],
      o,
    )
  }

  textures(): { albedo: Texture; normal: Texture } {
    return {
      albedo: Texture.create({ width: this.w, height: this.h, mips: [this.albedo] }),
      normal: Texture.create({
        width: this.w,
        height: this.h,
        usage: 'normal',
        mips: [this.normal],
      }),
    }
  }
}

/** Tilts toward the nearest edge of a w × h box within `bevel` pixels: stones and bricks. */
function bevel(x: number, y: number, w: number, h: number, b: number): [number, number, number] {
  const l = x + 0.5
  const r = w - x - 0.5
  const t = y + 0.5
  const d = h - y - 0.5
  const m = Math.min(l, r, t, d)
  if (m >= b) return [0, 0, 1]
  const s = 1 - m / b
  if (m === l) return [-s, 0, 1]
  if (m === r) return [s, 0, 1]
  if (m === t) return [0, s, 1]
  return [0, -s, 1]
}

/** Four tiles, 16 × 16: three floor stones and a brick wall. */
function tileSheet(rng: Rng): Sheet {
  const s = new Sheet(64, 16)
  for (let tile = 0; tile < 3; tile++) {
    const base: Rgb = [
      [92, 96, 110],
      [84, 90, 100],
      [100, 98, 104],
    ][tile] as Rgb
    // Two stones per tile, split at a random row.
    const split = 6 + tile * 2
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const top = y < split
        const n = bevel(x, top ? y : y - split, 16, top ? split : 16 - split, 2.5)
        const grain = rng.range(-10, 10)
        const edge = n[2] === 1 ? 1 : 0.8
        const c: Rgb = [
          (base[0] + grain) * edge,
          (base[1] + grain) * edge,
          (base[2] + grain) * edge,
        ]
        s.put(tile * 16 + x, y, c, 255, [
          n[0] + rng.range(-0.08, 0.08),
          n[1] + rng.range(-0.08, 0.08),
          1,
        ])
      }
    }
  }
  // Bricks: 8 × 4, rows offset by half a brick.
  for (let y = 0; y < 16; y++) {
    const row = Math.floor(y / 4)
    for (let x = 0; x < 16; x++) {
      const bx = (x + (row % 2) * 4) % 8
      const n = bevel(bx, y % 4, 8, 4, 1.5)
      const g = rng.range(-12, 12)
      const mortar = n[2] !== 1 && (bx === 0 || y % 4 === 0)
      const c: Rgb = mortar ? [50, 46, 44] : [128 + g, 92 + g, 76 + g]
      s.put(48 + x, y, c, 255, n)
    }
  }
  return s
}

/** Props, 16 × 16 each: a crate, a barrel, a crystal, and the lantern bearer. */
function propSheet(): Sheet {
  const s = new Sheet(64, 16)
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      // Crate: a beveled frame around planks.
      const frame = x < 2 || x > 13 || y < 2 || y > 13
      const n = frame ? bevel(x, y, 16, 16, 2) : bevel(x - 2, (y - 2) % 4, 12, 4, 1)
      const c: Rgb = frame ? [150, 104, 60] : [120 + ((y >> 2) % 2) * 14, 82, 48]
      s.put(x, y, c, 255, n)
      // Barrel: a disc, domed, with two hoops.
      const dx = (x + 0.5 - 8) / 7.5
      const dy = (y + 0.5 - 8) / 7.5
      const r2 = dx * dx + dy * dy
      if (r2 < 1) {
        const hoop = Math.abs(Math.sqrt(r2) - 0.75) < 0.08
        const z = Math.sqrt(1 - r2)
        s.put(16 + x, y, hoop ? [70, 72, 80] : [112, 74, 44], 255, [dx, -dy, z * 1.5])
      }
      // Crystal: a faceted diamond.
      const cx = x + 0.5 - 8
      const cy = y + 0.5 - 8
      if (Math.abs(cx) / 5 + Math.abs(cy) / 7.5 < 1) {
        s.put(32 + x, y, [235, 240, 255], 255, [Math.sign(cx) * 0.6, -Math.sign(cy) * 0.4, 1])
      }
      // The bearer: a hooded disc.
      if (r2 < 0.8) {
        const z = Math.sqrt(1 - r2 / 0.8)
        s.put(48 + x, y, [70, 110, 160], 255, [dx, -dy, z])
      }
    }
  }
  return s
}

/** A soft round glow for flames and fireflies (drawn additive, unlit). */
function glowTexture(): Texture {
  const size = 16
  const data = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.hypot(x + 0.5 - 8, y + 0.5 - 8) / 8
      const a = Math.max(0, 1 - r) ** 2
      data.set([255, 255, 255, Math.round(a * 255)], (y * size + x) * 4)
    }
  }
  return Texture.create({ width: size, height: size, mips: [data] })
}

/** Walls: the border, a room divider with doorways, and pillars in the east hall. */
function wallAt(x: number, y: number): boolean {
  if (x < 2 || y < 2 || x >= MAP_W - 2 || y >= MAP_H - 2) return true
  if (x >= 22 && x < 24 && !(y >= 17 && y < 23)) return true
  if (y >= 20 && y < 22 && x < 22 && !(x >= 8 && x < 13)) return true
  if (x >= 42 && x < 44 && !(y >= 8 && y < 13) && !(y >= 28 && y < 32)) return true
  const px = (x - 28) % 7
  const py = (y - 6) % 9
  if (x >= 28 && x < 40 && y >= 6 && y < 34 && px < 2 && py < 2) return true
  return false
}

/** Tile (x, y)'s center in world space. */
function tileCenter(x: number, y: number): [number, number] {
  return [ORIGIN_X + (x + 0.5) * TILE, ORIGIN_Y - (y + 0.5) * TILE]
}

interface Demo {
  camera: Entity
  bearer: Entity
  flashlight: Entity
  lantern: Entity
  beacon: Entity
  torches: { entity: Entity; flame: Entity; base: number; phase: number }[]
  crates: { entity: Entity; x: number; y: number; axis: 0 | 1; phase: number }[]
  fireflies: { light: Entity; dot: Entity; x: number; y: number; phase: number; speed: number }[]
  shadowedLights: Entity[]
  keys: Set<string>
  aim: [number, number]
  soft: boolean
  lit: boolean
  dusk: boolean
  flies: boolean
}

let demo: Demo | undefined

const motion = defineSystem({
  name: 'lights2d-demo/motion',
  run: (_, world) => {
    const d = demo
    if (!d) return
    const time = world.resource(Time)
    const t = time.elapsed
    const dt = time.delta
    // Torches flicker: a few incommensurate sines.
    for (const torch of d.torches) {
      const f =
        0.85 +
        0.08 * Math.sin(t * 13 + torch.phase) +
        0.05 * Math.sin(t * 23.7 + torch.phase * 2) +
        0.04 * Math.sin(t * 5.3 + torch.phase * 3)
      world.set(torch.entity, PointLight2d, { intensity: torch.base * f })
      world.set(torch.flame, Transform, { scale: [1, 0.9 + 0.2 * f, 1] })
    }
    // The bearer walks on WASD, stopped by walls.
    const k = d.keys
    const held = (...codes: string[]) => codes.some((c) => k.has(c))
    const dx = (held('KeyD', 'ArrowRight') ? 1 : 0) - (held('KeyA', 'ArrowLeft') ? 1 : 0)
    const dy = (held('KeyW', 'ArrowUp') ? 1 : 0) - (held('KeyS', 'ArrowDown') ? 1 : 0)
    const [bx, by] = world.get(d.bearer, Transform).translation
    let nx = bx!
    let ny = by!
    const blocked = (x: number, y: number) => {
      const r = 0.3
      for (const [ox, oy] of [
        [-r, -r],
        [r, -r],
        [-r, r],
        [r, r],
      ] as const) {
        const tx = Math.floor((x + ox - ORIGIN_X) / TILE)
        const ty = Math.floor((ORIGIN_Y - (y + oy)) / TILE)
        if (wallAt(tx, ty)) return true
      }
      return false
    }
    if (dx !== 0 && !blocked(bx! + dx * 5 * dt, by!)) nx = bx! + dx * 5 * dt
    if (dy !== 0 && !blocked(nx, by! + dy * 5 * dt)) ny = by! + dy * 5 * dt
    world.set(d.bearer, Transform, { translation: [nx, ny, 0.5] })
    world.set(d.lantern, Transform, { translation: [nx, ny, 0] })
    // The flashlight points at the mouse.
    const angle = Math.atan2(d.aim[1] - ny, d.aim[0] - nx)
    world.set(d.flashlight, Transform, {
      translation: [nx, ny, 0],
      rotation: quat.fromAxisAngle(quat.create(), [0, 0, 1], angle) as unknown as Rgba,
    })
    // Crates slide, dragging their shadows.
    for (const c of d.crates) {
      const o = Math.sin(t * 0.6 + c.phase) * 1.5
      world.set(c.entity, Transform, {
        translation: [c.x + (c.axis === 0 ? o : 0), c.y + (c.axis === 1 ? o : 0), 0.2],
      })
    }
    // The beacon in the east hall sweeps around.
    world.set(d.beacon, Transform, {
      rotation: quat.fromAxisAngle(quat.create(), [0, 0, 1], t * 0.7) as unknown as Rgba,
    })
    // Fireflies wander.
    for (const f of d.fireflies) {
      const x = f.x + Math.sin(t * f.speed + f.phase) * 1.2 + Math.sin(t * 0.31 + f.phase * 3) * 0.6
      const y = f.y + Math.cos(t * f.speed * 0.8 + f.phase) * 0.9
      world.set(f.light, Transform, { translation: [x, y, 0] })
      world.set(f.dot, Transform, { translation: [x, y, 0.8] })
    }
  },
})

function toggle(world: World, what: 'overlay' | 'lighting' | 'soft' | 'dusk' | 'flies'): void {
  const d = demo
  if (!d) return
  if (what === 'overlay') {
    setOverlays(world, { lights2d: !isOverlayOn(world.resource(DebugOverlays), 'lights2d') })
  } else if (what === 'lighting') {
    d.lit = !d.lit
    if (d.lit) world.add(d.camera, Lighting2d, { ambient: d.dusk ? DUSK : NIGHT })
    else world.remove(d.camera, Lighting2d)
  } else if (what === 'soft') {
    d.soft = !d.soft
    for (const e of d.shadowedLights) {
      const light = world.has(e, PointLight2d) ? PointLight2d : SpotLight2d
      world.set(e, light, { softness: d.soft ? 0.25 : 0 })
    }
  } else if (what === 'dusk') {
    d.dusk = !d.dusk
    if (d.lit) world.set(d.camera, Lighting2d, { ambient: d.dusk ? DUSK : NIGHT })
  } else {
    d.flies = !d.flies
    for (const f of d.fireflies) {
      world.set(f.light, PointLight2d, { intensity: d.flies ? 0.6 : 0 })
      world.set(f.dot, Sprite, { color: [1, 0.95, 0.5, d.flies ? 1 : 0] })
    }
  }
}

/**
 * 2D lighting (0039): a dungeon at night. A normal-mapped stone floor and an occluding brick
 * wall layer, flickering torches with soft shadows, a flashlight on the mouse, sliding crates and
 * barrels that cast shadows, glowing crystals, and fireflies (unshadowed lights by the hundred).
 */
export const lights2dDemoPlugin = definePlugin({
  name: 'lights2d-demo',
  dependencies: ['sprite'],
  build(app) {
    app.addSystems(Update, motion)
    hudExtras.push((world) => {
      const d = demo
      const info = describeLights2d(world)
      const v = d && info?.views[`camera:${d.camera}`]
      const rows = [
        v
          ? `lights2d  ${v.lights} lit (${v.culled} culled), ${v.shadowed} shadowed, ${v.segments} segments, max ${v.maxLightsPerTile}/tile`
          : 'lights2d  off',
      ]
      if (v?.gpuMs.binAndShadows !== undefined) {
        rows.push(
          `gpu       bin+shadows ${v.gpuMs.binAndShadows.toFixed(2)} ms, sprites ${v.gpuMs.sprites?.toFixed(2) ?? '?'} ms`,
        )
      }
      rows.push(
        'wasd: walk   mouse: flashlight   l: overlay   space: lighting on/off',
        `shadows ${d?.soft ? 'soft' : 'hard'}   ambient ${d?.dusk ? 'dusk' : 'night'}   fireflies ${d?.flies ? 'on' : 'off'}`,
      )
      return rows
    })
  },
  ready(app) {
    const world = app.world
    const rng = new Rng(39)
    const textures = world.resource(Textures)
    const atlases = world.resource(TextureAtlases)
    const camera = world.spawn(
      [
        Camera3d,
        { projection: 'orthographic', orthoHeight: MAP_H * TILE + 1, clearColor: [0, 0, 0, 1] },
      ],
      [Tonemapping, { curve: 'agx' }],
      [Lighting2d, { ambient: NIGHT }],
      [Transform, { translation: [0, 0, 100] }],
    )

    // Tiles: floor everywhere, walls on an occluding layer. The atlas's normal page lights both.
    const tiles = tileSheet(rng).textures()
    const tileAtlas = new TextureAtlas(
      textures.add(tiles.albedo) as never,
      ['floor0', 'floor1', 'floor2', 'wall'].map((name, i) => ({
        name,
        rect: [i * 16, 0, 16, 16],
      })),
      textures.add(tiles.normal) as never,
    )
    const data = TilemapData.create(MAP_W, MAP_H, ['floor', 'walls'])
    const [floor, walls] = data.layers as [(typeof data.layers)[0], (typeof data.layers)[0]]
    walls.occludes = true
    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        floor.tiles[y * MAP_W + x] = 1 + rng.int(0, 2)
        floor.flags[y * MAP_W + x] = rng.int(0, 3)
        if (wallAt(x, y)) walls.tiles[y * MAP_W + x] = 4
      }
    }
    world.spawn(
      [
        Tilemap,
        {
          atlas: atlases.add(tileAtlas),
          data: world.resource(TilemapDatas).add(data),
          tileSize: [TILE, TILE],
          chunkSize: 16,
        },
      ],
      [Transform, { translation: [ORIGIN_X, ORIGIN_Y, 0] }],
    )

    const props = propSheet().textures()
    const propAtlas = atlases.add(
      new TextureAtlas(
        textures.add(props.albedo) as never,
        ['crate', 'barrel', 'crystal', 'bearer'].map((name, i) => ({
          name,
          rect: [i * 16, 0, 16, 16],
        })),
        textures.add(props.normal) as never,
      ),
    )
    const glow = textures.add(glowTexture())
    const shadowed: Entity[] = []

    // Torches along the walls: warm, flickering, soft shadows.
    const torchSpots: [number, number][] = [
      [4, 4],
      [18, 4],
      [4, 17],
      [12, 24],
      [4, 35],
      [18, 35],
      [26, 4],
      [38, 4],
      [26, 35],
      [38, 35],
      [47, 4],
      [59, 4],
      [47, 35],
      [59, 35],
    ]
    const torches: Demo['torches'] = []
    for (const [tx, ty] of torchSpots) {
      const [x, y] = tileCenter(tx, ty)
      const entity = world.spawn(
        [
          PointLight2d,
          {
            color: [1, 0.62, 0.3, 1],
            intensity: 1.4,
            radius: 7,
            falloff: 1.6,
            height: 1.2,
            shadows: true,
            softness: 0.25,
          },
        ],
        [Transform, { translation: [x, y, 0] }],
      )
      shadowed.push(entity)
      const flame = world.spawn(
        [
          Sprite,
          {
            texture: glow,
            size: [0.7, 0.9],
            color: [1, 0.7, 0.35, 1],
            blend: 'additive',
            lit: false,
            layer: 2,
          },
        ],
        [Transform, { translation: [x, y, 1] }],
      )
      torches.push({ entity, flame, base: 1.4, phase: rng.range(0, 10) })
    }

    // Crates and barrels scattered through the rooms; some crates slide.
    const crates: Demo['crates'] = []
    const free = (x: number, y: number) => {
      for (let j = -2; j <= 2; j++)
        for (let i = -2; i <= 2; i++) if (wallAt(x + i, y + j)) return false
      return true
    }
    let placed = 0
    while (placed < 26) {
      const tx = rng.int(3, MAP_W - 4)
      const ty = rng.int(3, MAP_H - 4)
      if (!free(tx, ty)) continue
      const [x, y] = tileCenter(tx, ty)
      const barrel = placed % 3 === 2
      const entity = world.spawn(
        [
          Sprite,
          { atlas: propAtlas, region: barrel ? 'barrel' : 'crate', size: [0.9, 0.9], layer: 1 },
        ],
        [
          LightOccluder2d,
          barrel ? { shape: 'circle', size: [0.42, 0] } : { shape: 'box', size: [0.9, 0.9] },
        ],
        [Transform, { translation: [x, y, 0.2] }],
      )
      if (!barrel && placed % 4 === 0) {
        crates.push({
          entity,
          x,
          y,
          axis: (placed % 8 === 0 ? 0 : 1) as 0 | 1,
          phase: rng.range(0, 6),
        })
      }
      placed++
    }

    // Crystals: emissive, each with its own colored light.
    const crystalColors: [number, number, number, number][] = [
      [0.3, 0.9, 1, 1],
      [0.9, 0.3, 1, 1],
      [0.4, 1, 0.5, 1],
      [1, 0.35, 0.35, 1],
      [0.35, 0.5, 1, 1],
    ]
    const crystalSpots: [number, number][] = [
      [10, 10],
      [52, 18],
      [33, 20],
      [14, 30],
      [55, 30],
    ]
    crystalSpots.forEach(([tx, ty], i) => {
      const [x, y] = tileCenter(tx, ty)
      const color = crystalColors[i]!
      world.spawn(
        [Sprite, { atlas: propAtlas, region: 'crystal', size: [0.8, 1.1], color, layer: 1 }],
        [SpriteLighting, { emissive: 0.9 }],
        [Transform, { translation: [x, y, 0.3] }],
      )
      const light = world.spawn(
        [
          PointLight2d,
          { color, intensity: 1.2, radius: 4, height: 0.6, shadows: true, softness: 0.25 },
        ],
        [Transform, { translation: [x, y + 0.1, 0] }],
      )
      shadowed.push(light)
    })

    // The lantern bearer: a flashlight on the mouse and a dim lantern around them.
    const [sx, sy] = tileCenter(12, 30)
    const bearer = world.spawn(
      [Sprite, { atlas: propAtlas, region: 'bearer', size: [0.8, 0.8], layer: 3 }],
      [Transform, { translation: [sx, sy, 0.5] }],
    )
    const flashlight = world.spawn(
      [
        SpotLight2d,
        {
          color: [0.9, 0.95, 1, 1],
          intensity: 2,
          radius: 12,
          falloff: 1.2,
          height: 0.8,
          innerAngle: 14,
          outerAngle: 24,
          shadows: true,
          softness: 0.25,
        },
      ],
      [Transform, { translation: [sx, sy, 0] }],
    )
    shadowed.push(flashlight)
    const lantern = world.spawn(
      [PointLight2d, { color: [1, 0.85, 0.6, 1], intensity: 0.6, radius: 2.5, height: 0.5 }],
      [Transform, { translation: [sx, sy, 0] }],
    )

    // A beacon sweeping the pillared east hall.
    const [hx, hy] = tileCenter(34, 20)
    const beacon = world.spawn(
      [
        SpotLight2d,
        {
          color: [1, 0.25, 0.2, 1],
          intensity: 2.5,
          radius: 11,
          innerAngle: 8,
          outerAngle: 14,
          shadows: true,
          softness: 0.25,
        },
      ],
      [Transform, { translation: [hx, hy, 0] }],
    )
    shadowed.push(beacon)

    // Fireflies: small unshadowed lights by the hundred.
    const fireflies: Demo['fireflies'] = []
    while (fireflies.length < 160) {
      const tx = rng.int(3, MAP_W - 4)
      const ty = rng.int(3, MAP_H - 4)
      if (wallAt(tx, ty)) continue
      const [x, y] = tileCenter(tx, ty)
      fireflies.push({
        light: world.spawn(
          [PointLight2d, { color: [1, 0.9, 0.4, 1], intensity: 0.6, radius: 1.3, height: 0.4 }],
          [Transform, { translation: [x, y, 0] }],
        ),
        dot: world.spawn(
          [
            Sprite,
            {
              texture: glow,
              size: [0.22, 0.22],
              color: [1, 0.95, 0.5, 1],
              blend: 'additive',
              lit: false,
              layer: 4,
            },
          ],
          [Transform, { translation: [x, y, 0.8] }],
        ),
        x,
        y,
        phase: rng.range(0, 20),
        speed: rng.range(0.3, 0.9),
      })
    }

    demo = {
      camera,
      bearer,
      flashlight,
      lantern,
      beacon,
      torches,
      crates,
      fireflies,
      shadowedLights: shadowed,
      keys: new Set(),
      aim: [sx + 4, sy],
      soft: true,
      lit: true,
      dusk: false,
      flies: true,
    }

    const canvas = document.getElementById('viewport') as HTMLCanvasElement
    canvas.addEventListener('pointermove', (event) => {
      // Orthographic, centered on the origin: pixels map straight to world units.
      const rect = canvas.getBoundingClientRect()
      const h = MAP_H * TILE + 1
      const w = (h * rect.width) / rect.height
      demo!.aim = [
        ((event.clientX - rect.left) / rect.width - 0.5) * w,
        -((event.clientY - rect.top) / rect.height - 0.5) * h,
      ]
    })
    window.addEventListener('keydown', (event) => {
      if (event.repeat) return
      demo?.keys.add(event.code)
      if (event.code === 'KeyL') toggle(world, 'overlay')
      if (event.code === 'Space') toggle(world, 'lighting')
    })
    window.addEventListener('keyup', (event) => demo?.keys.delete(event.code))
    window.addEventListener('blur', () => demo?.keys.clear())
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-lights2d]')) {
      const what = button.dataset.lights2d as Parameters<typeof toggle>[1]
      button.addEventListener('click', () => toggle(world, what))
    }
  },
})
