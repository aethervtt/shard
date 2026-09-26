import { ChildOf, defineSystem, type Entity, quat, Update, vec3 } from '@shard/core'
import { cube, sphere } from '@shard/mesh'
import {
  AmbientLight,
  Camera3d,
  DebugOverlays,
  DirectionalLight,
  Exposure,
  isOverlayOn,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
  overlayNames,
  setOverlays,
} from '@shard/render'
import { definePlugin, Time } from '@shard/runtime'
import {
  distance64,
  FloatingOrigin,
  Grid,
  GridCell,
  GridFramesResource,
  gridOf,
  lookAt,
  reparentToGrid,
  Transform,
} from '@shard/transform'
import { hudExtras } from './hud'

/**
 * Large-world coordinates (spec 0040): a star system grid 10¹¹ m from its star, a spinning planet
 * grid 30 000 km ahead, and a ship that flies at up to 3 000 km/s with the camera as the floating
 * origin. The station beside the start and the wingman stay rock steady; turn the origin off (O) to
 * see what f32 does at this distance.
 */

const CELL = 2000
/** The ship starts 10¹¹ m from the star at the system's origin. */
const START = 50_000_000
const PLANET_RADIUS = 3_000_000
/** Cells ahead of the start, along -z. */
const PLANET_AHEAD = 15_000
const SPEEDS = [0, 50, 500, 5_000, 50_000, 500_000, 3_000_000]
const SPIN = (2 * Math.PI) / 90 // one turn every 90 s

interface Demo {
  system: Entity
  planet: Entity
  ship: Entity
  wingman: Entity
  camera: Entity
  gear: number
  keys: Set<string>
  origin: boolean
}

let demo: Demo | undefined

const forward = [0, 0, 0] as [number, number, number]
const NEG_Z = [0, 0, -1] as const
const UP = [0, 1, 0] as const
const RIGHT = [1, 0, 0] as const
const turn = [0, 0, 0, 1] as [number, number, number, number]

/** Moves `e` along `forward` by `distance` metres; recentering carries it across cells. */
function advance(world: import('@shard/core').World, e: Entity, distance: number): void {
  const p = world.get(e, Transform).translation
  world.set(e, Transform, {
    translation: [
      p[0] + forward[0] * distance,
      p[1] + forward[1] * distance,
      p[2] + forward[2] * distance,
    ],
  })
}

const fly = defineSystem({
  name: 'grids-demo/fly',
  run: (_, world) => {
    const d = demo
    if (!d) return
    const dt = world.resource(Time).delta
    const held = (code: string) => d.keys.has(code)
    // Steer: yaw on A/D, pitch on R/F, in the ship's own frame.
    const yaw = (held('KeyA') ? 1 : 0) - (held('KeyD') ? 1 : 0)
    const pitch = (held('KeyR') ? 1 : 0) - (held('KeyF') ? 1 : 0)
    if (yaw !== 0 || pitch !== 0) {
      const r = [...world.get(d.ship, Transform).rotation] as [number, number, number, number]
      quat.multiply(r, r, quat.fromAxisAngle(turn, UP, yaw * 0.8 * dt))
      quat.multiply(r, r, quat.fromAxisAngle(turn, RIGHT, pitch * 0.8 * dt))
      quat.normalize(r, r)
      world.set(d.ship, Transform, { rotation: r })
      if (gridOf(world, d.wingman) === gridOf(world, d.ship))
        world.set(d.wingman, Transform, { rotation: r })
    }
    let step = SPEEDS[d.gear]! * dt
    if (step > 0) {
      vec3.transformQuat(forward, NEG_Z, world.get(d.ship, Transform).rotation)
      // Stop above the surface when heading down: at 3 000 km/s one frame is 50 km.
      const before = distance64(world, d.ship, d.planet)
      advance(world, d.ship, step)
      const after = distance64(world, d.ship, d.planet)
      if (after < before && after - PLANET_RADIUS < 20_000) {
        advance(world, d.ship, -step)
        step = 0
        d.gear = 0
      }
      if (step > 0 && gridOf(world, d.wingman) === gridOf(world, d.ship))
        advance(world, d.wingman, step)
    }
    // The planet spins; entities in its grid turn with it.
    const spin = quat.fromAxisAngle([0, 0, 0, 1], UP, SPIN * world.resource(Time).elapsed)
    world.set(d.planet, Transform, { rotation: spin as [number, number, number, number] })
  },
})

function nameOf(d: Demo, grid: Entity | null | undefined): string {
  if (grid === d.system) return 'system'
  if (grid === d.planet) return 'planet'
  return 'root'
}

export const gridsDemoPlugin = definePlugin({
  name: 'grids-demo',
  build(app) {
    app.addSystems(Update, fly)
    hudExtras.push((world) => {
      const d = demo
      if (!d) return []
      const frames = world.resource(GridFramesResource)
      const originGrid = frames.originSlot === 0 ? null : frames.entity[frames.originSlot]
      const cell = [...frames.originCell].map((c) => c.toLocaleString()).join(', ')
      const speed = SPEEDS[d.gear]!
      const toSurface = distance64(world, d.ship, d.planet) - PLANET_RADIUS
      return [
        '',
        d.origin
          ? `origin    ${nameOf(d, originGrid)} grid, cell [${cell}]`
          : 'origin    off: positions are f32 from the system origin',
        `ship      in the ${nameOf(d, gridOf(world, d.ship))} grid, ${speed >= 1000 ? `${(speed / 1000).toLocaleString()} km/s` : `${speed} m/s`}`,
        `planet    ${(toSurface / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} km to the surface`,
        'w/s speed  a/d yaw  r/f pitch  g enter/leave planet grid',
        `o floating origin ${d.origin ? 'on' : 'off'}${overlayNames().includes('grids') ? '  c cell overlay' : ''}`,
      ]
    })
  },
  ready(app) {
    const world = app.world
    const meshes = world.resource(Meshes)
    const materials = world.resource(Materials)
    const mat = (value: ConstructorParameters<typeof MaterialAsset>[0]) =>
      materials.add(new MaterialAsset(value))

    world.resource(AmbientLight).brightness = 400
    // The star sits at the system's origin, 10¹¹ m behind the ship (+x): light comes from there.
    world.spawn(
      [DirectionalLight, { illuminance: 80_000 }],
      [Transform, { rotation: lookAt([0, 0, 0], [0.6, -0.35, -0.7]) }],
    )

    const system = world.spawn([Grid, { cellSize: CELL }], Transform)
    world.spawn(
      [Mesh3d, { mesh: meshes.add(sphere({ radius: 7e8, segments: 48, rings: 24 })) }],
      [
        MeshMaterial,
        {
          material: mat({
            baseColor: [0, 0, 0, 1],
            emissive: [1, 0.85, 0.6, 1],
            emissiveLuminance: 20_000,
          }),
        },
      ],
      Transform,
      [ChildOf, { parent: system }],
    )

    // The planet: its own grid, spinning, with a tower on its north pole.
    const planet = world.spawn(
      [Grid, { cellSize: CELL }],
      [GridCell, { cell: [START, 0, -PLANET_AHEAD] }],
      Transform,
      [ChildOf, { parent: system }],
    )
    world.spawn(
      [Mesh3d, { mesh: meshes.add(sphere({ radius: PLANET_RADIUS, segments: 128, rings: 64 })) }],
      [MeshMaterial, { material: mat({ baseColor: [0.22, 0.42, 0.55, 1], roughness: 0.85 }) }],
      Transform,
      [ChildOf, { parent: planet }],
    )
    const box = meshes.add(cube({ size: 1 }))
    world.spawn(
      [Mesh3d, { mesh: box }],
      [MeshMaterial, { material: mat({ baseColor: [0.9, 0.3, 0.2, 1], roughness: 0.5 }) }],
      [GridCell, { cell: [0, PLANET_RADIUS / CELL, 0] }],
      [Transform, { translation: [0, 400, 0], scale: [60, 800, 60] }],
      [ChildOf, { parent: planet }],
    )

    // A station beside the start: a hub and four arms.
    const steel = mat({ baseColor: [0.7, 0.72, 0.78, 1], metallic: 1, roughness: 0.35 })
    const station = world.spawn(
      [GridCell, { cell: [START, 0, 0] }],
      [Transform, { translation: [35, -8, -90] }],
      [ChildOf, { parent: system }],
    )
    world.spawn(
      [Mesh3d, { mesh: meshes.add(sphere({ radius: 8, segments: 32, rings: 16 })) }],
      [MeshMaterial, { material: steel }],
      Transform,
      [ChildOf, { parent: station }],
    )
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2
      world.spawn(
        [Mesh3d, { mesh: box }],
        [MeshMaterial, { material: steel }],
        [
          Transform,
          {
            translation: [Math.cos(a) * 18, 0, Math.sin(a) * 18],
            rotation: quat.fromAxisAngle([0, 0, 0, 1], UP, -a) as [number, number, number, number],
            scale: [22, 2, 3],
          },
        ],
        [ChildOf, { parent: station }],
      )
    }

    // The ship, a wingman flying in formation, and the camera (the floating origin) behind the ship.
    const hull = mat({ baseColor: [0.85, 0.85, 0.9, 1], roughness: 0.4 })
    const glow = mat({
      baseColor: [0, 0, 0, 1],
      emissive: [0.3, 0.7, 1, 1],
      emissiveLuminance: 3000,
    })
    const craft = (cell: number, x: number) => {
      const e = world.spawn(
        [GridCell, { cell: [START, 0, cell] }],
        [Transform, { translation: [x, 0, 0] }],
        [ChildOf, { parent: system }],
      )
      world.spawn(
        [Mesh3d, { mesh: box }],
        [MeshMaterial, { material: hull }],
        [Transform, { scale: [1.2, 0.6, 4] }],
        [ChildOf, { parent: e }],
      )
      world.spawn(
        [Mesh3d, { mesh: box }],
        [MeshMaterial, { material: hull }],
        [Transform, { translation: [0, 0, 0.8], scale: [5, 0.15, 1.2] }],
        [ChildOf, { parent: e }],
      )
      world.spawn(
        [Mesh3d, { mesh: box }],
        [MeshMaterial, { material: glow }],
        [Transform, { translation: [0, 0, 2.05], scale: [0.8, 0.4, 0.1] }],
        [ChildOf, { parent: e }],
      )
      return e
    }
    const ship = craft(0, 0)
    const wingman = craft(0, 9)
    world.set(wingman, Transform, { translation: [9, 1.5, -8] })
    const camera = world.spawn(
      [Camera3d, { fovY: 60, near: 0.2, clearColor: [0.004, 0.005, 0.01, 1] }],
      [Exposure, { ev100: 12 }],
      [Transform, { translation: [2, 3.5, 14], rotation: lookAt([2, 3.5, 14], [2, 0.5, -10]) }],
      FloatingOrigin,
      [ChildOf, { parent: ship }],
    )

    demo = { system, planet, ship, wingman, camera, gear: 0, keys: new Set(), origin: true }
    window.addEventListener('keyup', (event) => demo?.keys.delete(event.code))
    window.addEventListener('keydown', (event) => {
      const d = demo
      if (!d) return
      d.keys.add(event.code)
      if (event.code === 'KeyW') d.gear = Math.min(SPEEDS.length - 1, d.gear + 1)
      else if (event.code === 'KeyS') d.gear = Math.max(0, d.gear - 1)
      else if (event.code === 'KeyG') {
        // Into the planet's rotating grid (or back out), keeping the pose: no visible jump.
        const target = gridOf(world, d.ship) === d.planet ? d.system : d.planet
        reparentToGrid(world, d.ship, target)
        reparentToGrid(world, d.wingman, target)
      } else if (event.code === 'KeyO') {
        d.origin = !d.origin
        if (d.origin) world.add(d.camera, FloatingOrigin)
        else world.remove(d.camera, FloatingOrigin)
      } else if (event.code === 'KeyC' && overlayNames().includes('grids')) {
        setOverlays(world, { grids: !isOverlayOn(world.resource(DebugOverlays), 'grids') })
      }
    })
  },
})
