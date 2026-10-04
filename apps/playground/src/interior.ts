import { OrbitControls } from '@aethervtt/shard-controls'
import type { AssetRef, Entity, World } from '@aethervtt/shard-core'
import { box } from '@aethervtt/shard-mesh'
import {
  AmbientLight,
  Camera3d,
  DirectionalLight,
  Exposure,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
  PointLight,
  Visibility,
} from '@aethervtt/shard-render'
import { definePlugin } from '@aethervtt/shard-runtime'
import {
  Cutout,
  Floor,
  INTERIOR_QUALITIES,
  Interior,
  Opening,
  Roof,
  StructureSettings,
  Wall,
} from '@aethervtt/shard-structure'
import { lookAt, Transform } from '@aethervtt/shard-transform'
import { hudExtras } from './hud'

// Interior lighting (0069): a cottage whose roof is hidden but still casts, seen from an orbit.
// The hall has a window and a skylight, so sky light spills in and fades with distance; the
// cellar has none, so only its interior ambient and its torch light it; the side room opens onto
// the hall through a door. Torches are blocked by walls (polar rows from the plan, no shadow maps),
// so each lights its own room, and through a doorway when the door is open. In the yard a 1.2 m
// garden wall hides the ground behind it from a torch, but not the top of a pillar.

type Action = 'sky' | 'block' | 'quality' | 'doors' | 'roof' | 'night'

interface Demo {
  doors: Entity[]
  roof: Entity
  sun: Entity
  night: boolean
}

const demos = new WeakMap<World, Demo>()

const square = (x: number, z: number, w: number, d = w): [number, number][] => [
  [x, z],
  [x + w, z],
  [x + w, z + d],
  [x, z + d],
]

function material(world: World, c: [number, number, number], roughness = 0.9) {
  return world
    .resource(Materials)
    .add(new MaterialAsset({ baseColor: [...c, 1], roughness })) as AssetRef<'Material'>
}

/** A wall from a to b, 2.8 m tall. */
function wall(world: World, a: [number, number], b: [number, number], m: AssetRef<'Material'>) {
  return world.spawn([Wall, { a, b, height: 2.8, thickness: 0.2, material: m }])
}

function torch(world: World, x: number, y: number, z: number): Entity {
  const flame = world.spawn(
    [
      PointLight,
      {
        intensity: 9000,
        range: 7,
        falloff: 'tabletop',
        bright: 2,
        radius: 0.05,
        color: [1, 0.68, 0.38, 1],
        blockedByWalls: true,
      },
    ],
    [Transform, { translation: [x, y, z] }],
  )
  return flame
}

function build(world: World): Demo {
  const stone = material(world, [0.62, 0.6, 0.56])
  const plaster = material(world, [0.78, 0.74, 0.66])
  const boards = material(world, [0.42, 0.3, 0.2])
  const grass = material(world, [0.24, 0.32, 0.16], 1)
  // The yard: an outdoor floor, no roof over it.
  world.spawn([Floor, { points: square(-16, -14, 32, 28), material: grass }])
  // The cottage: x −6..6, z −4..4. The hall (x −6..2) with a south window; the side room
  // (x 2..6, z −4..0) and the cellar (x 2..6, z 0..4) east of it.
  const c = square(-6, -4, 12, 8)
  const south = wall(world, c[0]!, c[1]!, plaster)
  const east = wall(world, c[1]!, c[2]!, plaster)
  const north = wall(world, c[2]!, c[3]!, plaster)
  const west = wall(world, c[3]!, c[0]!, plaster)
  const split = wall(world, [2, -4], [2, 4], stone)
  wall(world, [2, 0], [6, 0], stone)
  world.spawn([
    Opening,
    { wall: south, kind: 'window', offset: 3, width: 1.6, height: 1.3, sill: 0.9, sight: 'none' },
  ])
  world.spawn([
    Opening,
    { wall: west, kind: 'window', offset: 3.2, width: 1.2, height: 1.2, sill: 1, sight: 'none' },
  ])
  void east
  void north
  const doors = [
    // The front door, in the south wall's east end (into the side room).
    world.spawn([Opening, { wall: south, kind: 'door', offset: 9.5, width: 1, height: 2.1 }]),
    // Hall to side room, and hall to cellar.
    world.spawn([Opening, { wall: split, kind: 'door', offset: 1.5, width: 1, height: 2.1 }]),
    world.spawn([Opening, { wall: split, kind: 'door', offset: 5.5, width: 1, height: 2.1 }]),
  ]
  for (const [x, w, m] of [
    [-6, 8, boards],
    [2, 4, stone],
  ] as const)
    world.spawn([Floor, { points: square(x, -4, w, 8), material: m, elevation: 0.02 }])
  const roof = world.spawn([
    Roof,
    { points: square(-6.5, -4.5, 13, 9), height: 2.8, pitch: 18, ridge: [0, 1], material: stone },
  ])
  world.spawn([Cutout, { host: roof, points: square(-3.6, 0.6, 1.4, 1.4), kind: 'skylight' }])
  // Hidden from the camera, still casting: the sun reaches in only through the openings.
  world.add(roof, Visibility, { mode: 'hidden' })
  // Torches: one per room, and one in the yard by the garden wall.
  torch(world, -4.5, 1.8, 2.8)
  torch(world, 4.6, 1.6, 2.5)
  torch(world, 4, 1.6, -2.2)
  torch(world, -2, 1.4, -9)
  // The garden wall (1.2 m) and a 2.2 m pillar behind it.
  world.spawn([Wall, { a: [-6, -11], b: [2, -11], height: 1.2, thickness: 0.25, material: stone }])
  world.spawn(
    [Mesh3d, { mesh: world.resource(Meshes).add(box({ x: 0.4, y: 2.2, z: 0.4 })) }],
    [MeshMaterial, { material: stone }],
    [Transform, { translation: [-2, 1.1, -12.6] }],
  )
  const sun = world.spawn(
    [DirectionalLight, { illuminance: 30_000, shadows: true, shadowUpdate: 'on-change' }],
    [Transform, { rotation: lookAt([-4, 7, -6], [0, 0, 0]) }],
  )
  Object.assign(world.resource(AmbientLight), { color: [0.75, 0.85, 1], brightness: 3500 })
  world.spawn(
    [Camera3d, { fovY: 45, clearColor: [0.45, 0.6, 0.8, 1] }],
    [Exposure, { ev100: 11 }],
    Transform,
    [OrbitControls, { distance: 22, yaw: -25, pitch: 52, minDistance: 5, maxDistance: 60 }],
  )
  return { doors, roof, sun, night: false }
}

function act(world: World, d: Demo, action: Action): void {
  // The settings as they'll apply: a patch earlier this frame over what the plugin last merged.
  const s = { ...world.resource(Interior).settings, ...world.resource(StructureSettings).interior }
  const patch = (p: object) =>
    world.patchResource(StructureSettings, { interior: { ...s, ...p } } as never)
  if (action === 'sky') patch({ sky: !s.sky })
  else if (action === 'block') patch({ blockLights: !s.blockLights })
  else if (action === 'quality') {
    const next = INTERIOR_QUALITIES[(INTERIOR_QUALITIES.indexOf(s.quality) + 1) % 3]!
    patch({ quality: next })
  } else if (action === 'doors') {
    const open = world.get(d.doors[0]!, Opening).state !== 'open'
    for (const door of d.doors) world.set(door, Opening, { state: open ? 'open' : 'closed' })
  } else if (action === 'roof') {
    const hidden = world.tryGet(d.roof, Visibility)?.mode === 'hidden'
    world.set(d.roof, Visibility, { mode: hidden ? 'inherit' : 'hidden' })
  } else if (action === 'night') {
    d.night = !d.night
    world.set(d.sun, DirectionalLight, { illuminance: d.night ? 0.3 : 30_000 })
    Object.assign(world.resource(AmbientLight), { brightness: d.night ? 40 : 3500 })
    for (const camera of world.query({ with: [Camera3d] }).entities())
      world.set(camera, Exposure, { ev100: d.night ? 6.5 : 11 })
  }
}

/** The playground's interior lighting demo (0069). */
export const interiorDemoPlugin = definePlugin({
  name: 'interior-demo',
  dependencies: ['structure', 'structure/interior', 'controls'],
  build() {
    // Everything is spawned in ready, once the render resources exist.
  },
  ready(app) {
    const world = app.world
    const d = build(world)
    demos.set(world, d)
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-interior]'))
      button.addEventListener('click', () => act(world, d, button.dataset.interior as Action))
    window.addEventListener('keydown', (e) => {
      const action = (['sky', 'block', 'quality', 'doors', 'roof', 'night'] as const)[
        Number(e.key) - 1
      ]
      if (action) act(world, d, action)
    })
    hudExtras.push((w) => {
      const s = w.resource(StructureSettings).interior
      const i = w.tryResource(Interior)
      if (!i) return []
      const last = i.last
      const rows = [...i.lights.values()].filter((c) => c.row >= 0).length
      return [
        `interior  sky ${s.sky ? 'on' : 'off'}   blocked lights ${s.blockLights ? 'on' : 'off'} (${rows} rows)   ${s.quality}`,
        last
          ? `field     ${last.full ? 'whole' : `${last.regions.length} region(s)`}, ${last.texels} texels, ${last.ms.toFixed(1)} ms; rows ${i.lastRows.lights} in ${i.lastRows.ms.toFixed(2)} ms`
          : 'field     none (no cover)',
      ]
    })
  },
})
