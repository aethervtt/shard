/**
 * #vehicles (0118): wheeled vehicles in seven scenarios — a proving ground, surface strips, hills
 * and jumps, a drift pad, off-road ground, a horde to plow through, and a garage of every class.
 * Keys 1–7 switch scenarios (`?scenario=`), WASD or the arrows drive, Space is the handbrake.
 */
import { assetServer } from '@aethervtt/shard-assets'
import {
  AudioClips,
  AudioEvent,
  type AudioEventDefinition,
  audioClip,
  prepareAudio,
} from '@aethervtt/shard-audio'
import { OrbitControls } from '@aethervtt/shard-controls'
import {
  type AssetRef,
  ChildOf,
  defineSystem,
  type Entity,
  PostUpdate,
  quat,
  Update,
  type World,
} from '@aethervtt/shard-core'
import { box, cylinder, type Mesh, plane } from '@aethervtt/shard-mesh'
import { ParticleEffect, ParticleEffects } from '@aethervtt/shard-particles'
import {
  CharacterController,
  CharacterIntent,
  Collider,
  ExternalImpulse,
  PhysicsConfig,
  RigidBody,
  RoadConditions,
  type SurfacePreset,
  Surfaces,
  surfacePreset,
  Velocity,
} from '@aethervtt/shard-physics'
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
  setOverlays,
} from '@aethervtt/shard-render'
import { type App, definePlugin, Time } from '@aethervtt/shard-runtime'
import { Texture, Textures } from '@aethervtt/shard-texture'
import { GlobalTransform, Transform, TransformSystems } from '@aethervtt/shard-transform'
import {
  captureVehicle,
  spawnVehicle,
  testTemplate,
  VEHICLE_CLASS_VALUES,
  VEHICLE_CLASSES,
  VehicleAssists,
  type VehicleClass,
  VehicleHitEvent,
  VehicleInput,
  VehicleSimsResource,
  VehicleState,
  type VehicleTestReport,
  VehicleTransmission,
  VehicleWheel,
  WheelState,
} from '@aethervtt/shard-vehicle'
import { VehicleAudio } from '@aethervtt/shard-vehicle/audio'
import { VehicleEffects } from '@aethervtt/shard-vehicle/effects'
import { orbitFrom } from './camera'
import { hudExtras } from './hud'

export const SCENARIOS = [
  ['proving', 'Proving ground: cones, a braking zone, a skidpad'],
  ['surfaces', 'Surfaces: asphalt, gravel, dirt, grass, mud, sand, snow, ice'],
  ['hills', 'Hills and jumps: a 20% climb, curbs, washboard, a jump'],
  ['drift', 'Drift pad: an arcade sports car'],
  ['offroad', 'Off-road: hills, a mud pit and dunes, in a 4WD'],
  ['horde', 'Horde: plow through a crowd'],
  ['garage', 'Garage: every class (Tab drives the next)'],
] as const
export type Scenario = (typeof SCENARIOS)[number][0]

const ASSISTS = ['none', 'sim', 'arcade'] as const

const demo = {
  scenario: 'proving' as Scenario,
  car: -1 as Entity,
  cars: [] as Entity[],
  camera: -1 as Entity,
  chase: true,
  overlay: false,
  assists: 1,
  keys: new Set<string>(),
  report: undefined as VehicleTestReport | undefined,
  testing: false,
  hits: 0,
  audio: undefined as Record<string, AssetRef<'audio/AudioEvent'>> | undefined,
  effects: undefined as Record<string, AssetRef<'ParticleEffect'>> | undefined,
  note: '',
  /** Driven by window.vehiclesDemo.drive (tests, agents): the keyboard leaves it alone. */
  scripted: false,
}

/** The scenario from `?scenario=`, else the proving ground. */
function scenarioOf(): Scenario {
  const s = new URLSearchParams(location.search).get('scenario')
  return (SCENARIOS.find(([name]) => name === s)?.[0] ?? 'proving') as Scenario
}

// --- materials and meshes ------------------------------------------------------------------

const materialCache = new Map<string, AssetRef>()

function material(world: World, color: [number, number, number], roughness = 0.8, metallic = 0) {
  const key = `${color.join(',')}:${roughness}:${metallic}`
  let ref = materialCache.get(key)
  if (!ref) {
    ref = world
      .resource(Materials)
      .add(new MaterialAsset({ baseColor: [...color, 1], roughness, metallic })) as AssetRef
    materialCache.set(key, ref)
  }
  return ref
}

function mesh(world: World, m: Mesh) {
  return world.resource(Meshes).add(m) as AssetRef
}

function visual(
  world: World,
  m: Mesh,
  color: [number, number, number],
  at: [number, number, number],
  parent?: Entity,
  rotation: [number, number, number, number] = [0, 0, 0, 1],
): Entity {
  const e = world.spawn(
    [Mesh3d, { mesh: mesh(world, m) as never }],
    [MeshMaterial, { material: material(world, color) as never }],
    [Transform, { translation: at, rotation }],
  )
  if (parent !== undefined) world.add(e, ChildOf, { parent })
  return e
}

/** A wheel: a tire cylinder along X with two crossed spokes, so spinning shows. */
function wheelMesh(radius: number, width: number): Mesh {
  const tire = cylinder({ radius, height: width, segments: 28 })
  const p = tire.positions
  // Axis Y → X.
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i]!
    p[i] = p[i + 1]!
    p[i + 1] = -x
  }
  if (tire.normals) {
    const n = tire.normals
    for (let i = 0; i < n.length; i += 3) {
      const x = n[i]!
      n[i] = n[i + 1]!
      n[i + 1] = -x
    }
  }
  return tire
}

/** A car body from its class: a lower body, a cabin, and lights, on the chassis. */
function dressCar(
  world: World,
  chassis: Entity,
  cls: VehicleClass,
  color: [number, number, number],
) {
  const c = VEHICLE_CLASS_VALUES[cls]
  const [bodyX, hy, hz] = c.body
  // Narrower than the track, so the tires stand outside the body and their spin shows.
  const hx = Math.min(bodyX, c.track / 2 - c.width / 2 - 0.03)
  visual(
    world,
    box({ x: hx * 2, y: hy * 1.1, z: hz * 2 }),
    color,
    [0, c.bodyY - hy * 0.4, 0],
    chassis,
  )
  const cabinLen =
    cls === 'van' || cls === 'bus' ? hz * 1.9 : cls === 'pickup' ? hz * 0.8 : hz * 1.1
  const cabinZ = cls === 'pickup' ? -hz * 0.25 : cls === 'truck' ? -hz * 0.7 : 0
  visual(
    world,
    box({ x: hx * 1.8, y: hy * 0.9, z: cabinLen }),
    [color[0] * 0.35, color[1] * 0.35, color[2] * 0.4],
    [0, c.bodyY + hy * 0.55, cabinZ],
    chassis,
  )
  // Head and tail lights.
  for (const sx of [-1, 1]) {
    visual(
      world,
      box({ x: 0.25, y: 0.1, z: 0.05 }),
      [1, 0.95, 0.8],
      [sx * hx * 0.7, c.bodyY - hy * 0.2, -hz - 0.01],
      chassis,
    )
    visual(
      world,
      box({ x: 0.25, y: 0.1, z: 0.05 }),
      [0.8, 0.05, 0.05],
      [sx * hx * 0.7, c.bodyY - hy * 0.2, hz + 0.01],
      chassis,
    )
  }
}

/** Wheel visuals: a tire per wheel (and its spokes), children of the chassis at the hubs. */
function dressWheels(world: World, chassis: Entity, wheels: Entity[]) {
  for (const w of wheels) {
    const wv = world.get(w, VehicleWheel)
    const at = world.get(w, Transform).translation
    const tire = visual(
      world,
      wheelMesh(wv.radius, wv.width),
      [0.06, 0.06, 0.07],
      [at[0], at[1], at[2]],
      chassis,
    )
    // Spokes: two bars through the hub, children of the tire so they turn with it.
    visual(
      world,
      box({ x: wv.width * 1.05, y: wv.radius * 1.5, z: 0.06 }),
      [0.75, 0.75, 0.78],
      [0, 0, 0],
      tire,
    )
    visual(
      world,
      box({ x: wv.width * 1.05, y: 0.06, z: wv.radius * 1.5 }),
      [0.75, 0.75, 0.78],
      [0, 0, 0],
      tire,
    )
    world.set(w, VehicleWheel, { visual: tire })
  }
}

const COLORS: Record<VehicleClass, [number, number, number]> = {
  sedan: [0.12, 0.3, 0.75],
  sports: [0.85, 0.12, 0.08],
  pickup: [0.25, 0.45, 0.2],
  offroad: [0.55, 0.45, 0.25],
  van: [0.85, 0.85, 0.82],
  truck: [0.9, 0.6, 0.1],
  bus: [0.95, 0.75, 0.05],
}

function addCar(
  world: World,
  cls: VehicleClass,
  at: [number, number, number],
  yaw = 0,
  assists?: Record<string, unknown>,
): Entity {
  const c = VEHICLE_CLASS_VALUES[cls]
  const v = spawnVehicle(world, {
    class: cls,
    at: [at[0], at[1] + c.radius + 0.05, at[2]],
    yaw,
    assists: assists ?? {
      preset: ASSISTS[demo.assists] === 'none' ? 'custom' : ASSISTS[demo.assists],
    },
    rearAxles: cls === 'truck' || cls === 'bus' ? 2 : 1,
  })
  dressCar(world, v.chassis, cls, COLORS[cls])
  dressWheels(world, v.chassis, v.wheels)
  if (demo.audio) world.add(v.chassis, VehicleAudio, demo.audio)
  if (demo.effects) {
    const e = demo.effects
    world.add(v.chassis, VehicleEffects, {
      surfaces: [
        { surface: 'gravel', particles: e.dust!, tracks: false },
        { surface: 'dirt', particles: e.dust!, tracks: true },
        { surface: 'sand', particles: e.sand!, tracks: true },
        { surface: 'mud', particles: e.mud!, tracks: true },
        { surface: 'fresh-snow', particles: e.snow!, tracks: true },
        { surface: 'snow', particles: e.snow!, tracks: true },
        { surface: 'grass', particles: e.grass!, tracks: false },
      ],
      smoke: e.smoke!,
    })
  }
  demo.cars.push(v.chassis)
  return v.chassis
}

// --- ground --------------------------------------------------------------------------------

const SURFACE_COLORS: Record<SurfacePreset, [number, number, number]> = {
  asphalt: [0.12, 0.12, 0.13],
  concrete: [0.45, 0.45, 0.43],
  gravel: [0.42, 0.38, 0.33],
  dirt: [0.36, 0.25, 0.15],
  grass: [0.18, 0.36, 0.12],
  mud: [0.22, 0.15, 0.08],
  sand: [0.78, 0.68, 0.45],
  snow: [0.85, 0.88, 0.92],
  'fresh-snow': [0.95, 0.96, 0.98],
  ice: [0.65, 0.8, 0.9],
}

/**
 * A flat slab of a surface: box colliders and its visual, top at `y`. Colliders are tiles of at
 * most 100 m: shape casts against one huge box lose precision.
 */
function slab(
  world: World,
  surface: SurfacePreset,
  center: [number, number],
  size: [number, number],
  y = 0,
  color = SURFACE_COLORS[surface],
): void {
  const nx = Math.ceil(size[0] / 100)
  const nz = Math.ceil(size[1] / 100)
  const tx = size[0] / nx
  const tz = size[1] / nz
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < nz; j++) {
      world.spawn(
        [RigidBody, { kind: 'fixed' }],
        [
          Collider,
          {
            shape: 'cuboid',
            halfExtents: [tx / 2, 0.5, tz / 2],
            surface: surfacePreset(surface),
          },
        ],
        [
          Transform,
          {
            translation: [
              center[0] - size[0] / 2 + (i + 0.5) * tx,
              y - 0.5,
              center[1] - size[1] / 2 + (j + 0.5) * tz,
            ],
          },
        ],
      )
    }
  visual(world, box({ x: size[0], y: 0.02, z: size[1] }), color, [center[0], y - 0.005, center[1]])
}

/** A ramp: a tilted box rising toward −Z by `rise` over `length`. */
function ramp(
  world: World,
  center: [number, number],
  width: number,
  length: number,
  rise: number,
  color: [number, number, number] = [0.5, 0.5, 0.52],
) {
  const angle = Math.atan2(rise, length)
  const half = angle / 2
  const rot: [number, number, number, number] = [Math.sin(half), 0, 0, Math.cos(half)]
  const thick = 0.4
  const hyp = Math.hypot(length, rise)
  // The top face's middle sits at height rise / 2 over the center.
  const cy = rise / 2 - (thick / 2) * Math.cos(angle)
  const cz = center[1] - (thick / 2) * Math.sin(angle)
  world.spawn(
    [RigidBody, { kind: 'fixed' }],
    [Collider, { shape: 'cuboid', halfExtents: [width / 2, thick / 2, hyp / 2] }],
    [Transform, { translation: [center[0], cy, cz], rotation: rot }],
  )
  visual(world, box({ x: width, y: thick, z: hyp }), color, [center[0], cy, cz], undefined, rot)
}

/** A block: a box collider with its visual (curbs, walls). */
function block(
  world: World,
  at: [number, number, number],
  size: [number, number, number],
  color: [number, number, number],
) {
  world.spawn(
    [RigidBody, { kind: 'fixed' }],
    [Collider, { shape: 'cuboid', halfExtents: [size[0] / 2, size[1] / 2, size[2] / 2] }],
    [Transform, { translation: at }],
  )
  visual(world, box({ x: size[0], y: size[1], z: size[2] }), color, at)
}

/** A traffic cone: a light dynamic body you can knock over. */
function cone(world: World, at: [number, number]) {
  const e = world.spawn(
    [RigidBody, { kind: 'dynamic' }],
    [Collider, { shape: 'cone', radius: 0.18, halfHeight: 0.35, density: 30 }],
    [Velocity, {}],
    [Transform, { translation: [at[0], 0.36, at[1]] }],
  )
  visual(
    world,
    cylinder({ radius: 0.18, radiusTop: 0.02, height: 0.7, segments: 12 }),
    [1, 0.4, 0.05],
    [0, 0, 0],
    e,
  )
}

/** Rolling ground from a height function, as heightfield colliders and a grid mesh. */
function hills(
  world: World,
  surface: SurfacePreset,
  center: [number, number],
  size: number,
  height: (x: number, z: number) => number,
) {
  const n = 64
  const heights: number[] = []
  // Rows along Z, columns along X; the collider scales by halfExtents.
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) {
      const x = center[0] + (c / (n - 1) - 0.5) * size
      const z = center[1] + (r / (n - 1) - 0.5) * size
      heights.push(height(x, z))
    }
  world.spawn(
    [RigidBody, { kind: 'fixed' }],
    [
      Collider,
      {
        shape: 'heightfield',
        halfExtents: [size / 2, 1, size / 2],
        heightfield: { rows: n, cols: n, heights },
        surface: surfacePreset(surface),
      },
    ],
    [Transform, { translation: [center[0], 0, center[1]] }],
  )
  const m = plane({ size, subdivisions: n - 1 })
  const p = m.positions
  const nrm = m.normals
  const e = 0.5
  for (let i = 0; i < p.length; i += 3) {
    const x = center[0] + p[i]!
    const z = center[1] + p[i + 2]!
    p[i + 1] = height(x, z)
    if (!nrm) continue
    // The surface's normal from its slopes.
    const dx = (height(x + e, z) - height(x - e, z)) / (2 * e)
    const dz = (height(x, z + e) - height(x, z - e)) / (2 * e)
    const l = Math.hypot(dx, 1, dz)
    nrm[i] = -dx / l
    nrm[i + 1] = 1 / l
    nrm[i + 2] = -dz / l
  }
  visual(world, m, SURFACE_COLORS[surface], [center[0], 0, center[1]])
}

// --- scenarios -----------------------------------------------------------------------------

function proving(world: World) {
  slab(world, 'asphalt', [0, -150], [160, 500])
  slab(world, 'concrete', [0, 120], [160, 40], 0.001)
  // Slalom cones every 15 m down the middle, a braking box ahead, and a skidpad ring to the side.
  for (let i = 0; i < 10; i++) cone(world, [i % 2 ? 2 : -2, -30 - i * 15])
  for (let i = 0; i < 6; i++) {
    cone(world, [-6, -220 - i * 8])
    cone(world, [6, -220 - i * 8])
  }
  for (let a = 0; a < 24; a++) {
    const t = (a / 24) * Math.PI * 2
    cone(world, [50 + Math.cos(t) * 30, -80 + Math.sin(t) * 30])
  }
  demo.car = addCar(world, 'sedan', [0, 0, 0])
  demo.note = 'slalom ahead, braking box at 220 m, skidpad ring on the right'
}

function surfaces(world: World) {
  const list: SurfacePreset[] = [
    'asphalt',
    'gravel',
    'dirt',
    'grass',
    'mud',
    'sand',
    'snow',
    'fresh-snow',
    'ice',
  ]
  for (const [i, s] of list.entries()) slab(world, s, [(i - 4) * 14, -150], [14, 400])
  slab(world, 'concrete', [0, 80], [140, 60])
  // Signposts at each strip's start, between the strips (they don't block the way).
  for (const [i, s] of list.entries())
    block(world, [(i - 4) * 14 + 7, 1.2, 49], [0.3, 2.4, 0.3], SURFACE_COLORS[s])
  demo.car = addCar(world, 'sedan', [-56, 0, 70])
  demo.note = 'drive into a strip: asphalt, gravel, dirt, grass, mud, sand, snow, fresh snow, ice'
}

function hillsScenario(world: World) {
  slab(world, 'asphalt', [0, -100], [200, 400])
  // A 20% climb with a plateau, curbs to ride over, a washboard strip, and a jump.
  ramp(world, [-40, -60], 12, 50, 10)
  block(world, [-40, 9.8, -110], [12, 0.4, 50], [0.5, 0.5, 0.52])
  for (let i = 0; i < 6; i++)
    block(world, [0, 0.06, -30 - i * 12], [10, 0.12, 0.3], [0.8, 0.8, 0.8])
  slab(world, 'gravel', [20, -80], [10, 100], 0.002)
  ramp(world, [50, -60], 8, 10, 2.2, [0.8, 0.3, 0.1])
  demo.car = addCar(world, 'sedan', [0, 0, 20])
  demo.note = 'left: 20% hill · middle: curbs · right: washboard gravel, then the jump'
}

function drift(world: World) {
  slab(world, 'asphalt', [0, -60], [240, 240])
  for (let a = 0; a < 16; a++) {
    const t = (a / 16) * Math.PI * 2
    cone(world, [Math.cos(t) * 18, -60 + Math.sin(t) * 18])
  }
  demo.assists = 2
  demo.car = addCar(world, 'sports', [0, 0, 20], 0, { preset: 'arcade' })
  demo.note =
    'arcade assists: Space to kick the rear out, throttle to hold it, steer into the slide'
}

/** 0 at a square patch's edge, 1 from `fade` metres in: hills meet the flat ground. */
function edge(x: number, z: number, center: [number, number], size: number, fade = 15): number {
  const d = Math.min(size / 2 - Math.abs(x - center[0]), size / 2 - Math.abs(z - center[1]))
  const t = Math.max(0, Math.min(1, d / fade))
  return t * t * (3 - 2 * t)
}

function offroad(world: World) {
  slab(world, 'dirt', [0, 40], [80, 40])
  const hillsAt: [number, number] = [0, -60]
  hills(
    world,
    'grass',
    hillsAt,
    120,
    (x, z) =>
      edge(x, z, hillsAt, 120) *
      (1.8 * (1 + Math.sin(x * 0.07) * Math.cos(z * 0.06)) +
        0.8 * (1 + Math.sin(z * 0.15 + x * 0.05))),
  )
  slab(world, 'mud', [80, -60], [40, 120])
  const dunesAt: [number, number] = [-90, -60]
  hills(
    world,
    'sand',
    dunesAt,
    60,
    (x, z) => edge(x, z, dunesAt, 60, 10) * 1.6 * (1 + Math.sin(x * 0.25 + z * 0.08)),
  )
  demo.car = addCar(world, 'offroad', [0, 0, 40])
  demo.note = 'grass hills ahead, the mud pit right, dunes left · try a sedan there (Tab)'
}

function horde(world: World) {
  slab(world, 'asphalt', [0, -100], [200, 400])
  // A shuffling crowd across the road ahead: denser in the middle.
  for (let i = 0; i < 90; i++) {
    const x = ((((i * 37) % 100) / 100 - 0.5) * 12) ** 3 / 36
    const z = -30 - ((i * 53) % 180)
    zombie(world, [x, z])
  }
  demo.car = addCar(world, 'pickup', [0, 0, 10])
  demo.note = 'each hit costs the truck its share of momentum (vehicle/Hit)'
}

function zombie(world: World, at: [number, number]): Entity {
  const e = world.spawn(
    [Transform, { translation: [at[0], 0.95, at[1]] }],
    [CharacterController, { radius: 0.3, height: 1.8 }],
    [CharacterIntent, {}],
  )
  visual(
    world,
    cylinder({ radius: 0.3, height: 1.7, segments: 10 }),
    [0.35, 0.45, 0.3],
    [0, 0, 0],
    e,
  )
  visual(world, box({ x: 0.3, y: 0.3, z: 0.3 }), [0.6, 0.65, 0.5], [0, 1, 0], e)
  return e
}

function garage(world: World) {
  slab(world, 'asphalt', [0, -80], [240, 320])
  VEHICLE_CLASSES.forEach((cls, i) => {
    const car = addCar(world, cls, [(i - 3) * 6, 0, 10])
    if (cls === 'sedan') demo.car = car
  })
  demo.note = 'Tab: drive the next class'
}

// --- input, camera, HUD --------------------------------------------------------------------

const drive = defineSystem({
  name: 'playground/vehicles-drive',
  run: (_, world) => {
    if (!world.isAlive(demo.car) || demo.scripted) return
    const k = demo.keys
    const steer =
      (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0)
    world.set(demo.car, VehicleInput, {
      throttle: k.has('KeyW') || k.has('ArrowUp') ? 1 : 0,
      brake: k.has('KeyS') || k.has('ArrowDown') ? 1 : 0,
      steer,
      handbrake: k.has('Space') ? 1 : 0,
    })
    // Parked cars hold still.
    for (const car of demo.cars) {
      if (car === demo.car || !world.isAlive(car)) continue
      const input = world.get(car, VehicleInput)
      if (input.throttle || input.steer || input.brake)
        world.set(car, VehicleInput, { throttle: 0, steer: 0, brake: 0, handbrake: 1 })
    }
  },
})

const chase = new Float64Array(3)
let chaseReady = false

/** The chase camera: behind and above the car, smoothed, looking a little ahead. */
const chaseCamera = defineSystem({
  name: 'playground/vehicles-camera',
  run: (_, world) => {
    if (!demo.chase || !world.isAlive(demo.car) || !world.isAlive(demo.camera)) return
    const dt = Math.min(0.05, world.resource(Time).delta)
    const t = world.get(demo.car, Transform)
    const [qx, qy, qz, qw] = t.rotation
    // Car forward (−Z) flattened.
    let fx = -(2 * (qx * qz + qw * qy))
    let fz = -(1 - 2 * (qx * qx + qy * qy))
    const l = Math.hypot(fx, fz) || 1
    fx /= l
    fz /= l
    const speed = world.tryGet(demo.car, VehicleState)?.speed ?? 0
    const back = 7 + Math.min(4, Math.abs(speed) * 0.08)
    const want = [
      t.translation[0] - fx * back,
      t.translation[1] + 2.6,
      t.translation[2] - fz * back,
    ]
    if (!chaseReady) {
      chase.set(want)
      chaseReady = true
    }
    const k = 1 - Math.exp(-dt * 4)
    for (let i = 0; i < 3; i++) chase[i] = chase[i]! + (want[i]! - chase[i]!) * k
    const target = [t.translation[0] + fx * 4, t.translation[1] + 0.8, t.translation[2] + fz * 4]
    const dx = target[0]! - chase[0]!
    const dy = target[1]! - chase[1]!
    const dz = target[2]! - chase[2]!
    const yaw = Math.atan2(-dx, -dz)
    const pitch = Math.atan2(dy, Math.hypot(dx, dz))
    // Yaw about Y, then pitch about the turned X.
    const sy = Math.sin(yaw / 2)
    const cy = Math.cos(yaw / 2)
    const sp = Math.sin(pitch / 2)
    const cp = Math.cos(pitch / 2)
    world.set(demo.camera, Transform, {
      translation: [chase[0]!, chase[1]!, chase[2]!],
      rotation: [cy * sp, sy * cp, -sy * sp, cy * cp],
    })
  },
})

function surfaceName(world: World, index: number): string {
  return world.tryResource(Surfaces)?.names[index] ?? '?'
}

function hudLines(world: World): string[] {
  const lines = [
    `scenario ${SCENARIOS.findIndex(([n]) => n === demo.scenario) + 1}/7 ${demo.scenario} — ${demo.note}`,
    '1–7 scenario · WASD/arrows drive · Space handbrake · Q/E shift (M: manual) · P assists · C camera · O overlay · R reset · T test · B rain',
  ]
  if (!world.isAlive(demo.car) || !world.has(demo.car, VehicleState)) return [...lines, 'loading…']
  const st = world.get(demo.car, VehicleState)
  const tr = world.tryGet(demo.car, VehicleTransmission)
  const assists = [
    st.assists & 1 ? 'ABS' : '',
    st.assists & 2 ? 'TCS' : '',
    st.assists & 4 ? 'ESC' : '',
  ]
    .filter(Boolean)
    .join(' ')
  const gear = st.gear < 0 ? 'R' : st.gear === 0 ? 'N' : String(st.gear)
  const rpmBar = '▮'.repeat(Math.round((st.rpm / 8000) * 20)).padEnd(20, '·')
  lines.push(
    `${(st.speed * 3.6).toFixed(0).padStart(4)} km/h · gear ${gear}${tr ? ` (${tr.mode})` : ''} · ${st.rpm.toFixed(0).padStart(5)} rpm ${rpmBar} · drift ${((st.driftAngle * 180) / Math.PI).toFixed(0)}° · ${assists || 'no assist acting'} · assists ${ASSISTS[demo.assists]}`,
  )
  const sim = world.resource(VehicleSimsResource).sims.get(demo.car)
  if (sim) {
    lines.push(
      `wheels: ${sim.wheels
        .map((w) => {
          const ws = world.get(w.entity, WheelState)
          return `${surfaceName(world, ws.surface)}${ws.grounded ? '' : ' (air)'} ${(ws.compression * 100).toFixed(0)}% slip ${ws.slipRatio.toFixed(2)}${ws.sinkage > 0.005 ? ` sunk ${(ws.sinkage * 100).toFixed(0)} cm` : ''}`
        })
        .join(' | ')}`,
    )
  }
  if (demo.scenario === 'horde') lines.push(`hits: ${demo.hits}`)
  const wet = world.resource(RoadConditions).wetness
  if (wet > 0) lines.push(`rain: wetness ${wet}`)
  if (demo.testing) lines.push('vehicle test: running…')
  else if (demo.report) {
    const r = demo.report
    lines.push(
      `vehicle test: 0–100 ${r.accel?.to100?.toFixed(1) ?? '—'} s · 100–0 ${r.brake?.distance.toFixed(1)} m${r.brake?.abs ? ' ABS' : ''} · skidpad ${r.skidpad?.lateralG.toFixed(2)} g · step ${r.step?.peakDrift.toFixed(0)}°${r.step?.rolled ? ' ROLLED' : ''} · top ${r.top?.reached.toFixed(0)} km/h`,
    )
  }
  return lines
}

/** Horde hits: the struck character becomes a tumbling body, flung by the car. */
const hits = defineSystem({
  name: 'playground/vehicles-hits',
  setup: (world) => ({ reader: world.reader(VehicleHitEvent) }),
  run: ({ reader }, world) => {
    for (const e of reader.read()) {
      demo.hits++
      const ch = e.other
      if (!world.isAlive(ch) || !world.has(ch, CharacterController)) continue
      const t = world.get(ch, Transform).translation
      world.remove(ch, CharacterController)
      if (world.has(ch, CharacterIntent)) world.remove(ch, CharacterIntent)
      world.set(ch, Transform, { translation: [t[0], t[1], t[2]] })
      world.add(ch, RigidBody, { kind: 'dynamic' })
      world.add(ch, Collider, { shape: 'capsule', radius: 0.3, halfHeight: 0.6, density: 300 })
      const v = world.get(e.vehicle, Velocity).linear
      world.add(ch, Velocity, {
        linear: [v[0] * 0.9 + e.normal[0] * 2, 3 + e.speed * 0.2, v[2] * 0.9 + e.normal[2] * 2],
        angular: [e.normal[2] * 6, 0, -e.normal[0] * 6],
      })
      world.add(ch, ExternalImpulse, {})
    }
  },
})

// --- sound and effects --------------------------------------------------------------------

/** A mono 16-bit WAV of `seconds` from a sample function. */
function wav(seconds: number, rate: number, sample: (t: number) => number): Uint8Array {
  const frames = Math.round(rate * seconds)
  const out = new Uint8Array(44 + frames * 2)
  const view = new DataView(out.buffer)
  const text = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i)
  }
  text(0, 'RIFF')
  view.setUint32(4, 36 + frames * 2, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, frames * 2, true)
  for (let i = 0; i < frames; i++) {
    const v = Math.max(-1, Math.min(1, sample(i / rate)))
    view.setInt16(44 + i * 2, Math.round(v * 32767), true)
  }
  return out
}

/** Seeded noise in [−1, 1]. */
function noise(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return (s / 4294967296) * 2 - 1
  }
}

/** Synthesized engine, tire and shift sounds, as audio events the cars' VehicleAudio names. */
async function makeAudio(world: World): Promise<Record<string, AssetRef<'audio/AudioEvent'>>> {
  const clips = world.resource(AudioClips)
  const rate = 22050
  // Engine: a four-cylinder's firing at 800 rpm (26.7 Hz) with harmonics and a little roughness;
  // whole periods in the loop so it doesn't click.
  const f0 = 800 / 60 / 0.5
  const periods = Math.round(f0 * 1)
  const len = periods / f0
  const rough = noise(7)
  const engine = clips.add(
    audioClip(
      wav(len, rate, (t) => {
        const ph = 2 * Math.PI * f0 * t
        return (
          0.5 * Math.sin(ph) +
          0.3 * Math.sin(2 * ph + 0.4) +
          0.18 * Math.sin(3 * ph + 1) +
          0.12 * Math.sin(4 * ph) +
          0.05 * rough()
        )
      }),
      { id: 'engine' },
    ),
  )
  const hiss = noise(11)
  let lp = 0
  const skid = clips.add(
    audioClip(
      wav(1.5, rate, () => {
        lp += (hiss() - lp) * 0.35
        return lp * 0.9
      }),
      { id: 'skid' },
    ),
  )
  let lp2 = 0
  const roll = clips.add(
    audioClip(
      wav(1.5, rate, () => {
        lp2 += (hiss() - lp2) * 0.04
        return lp2 * 2.5
      }),
      { id: 'roll' },
    ),
  )
  const crunch = noise(23)
  const gravel = clips.add(
    audioClip(
      wav(1.5, rate, (t) => (Math.sin(t * 90) > 0.6 ? crunch() * 0.6 : crunch() * 0.08)),
      { id: 'gravel' },
    ),
  )
  const clunk = clips.add(
    audioClip(
      wav(0.12, rate, (t) => Math.sin(2 * Math.PI * 110 * t) * Math.exp(-t * 40)),
      { id: 'clunk' },
    ),
  )
  const choice = (c: { guid?: string }) => [{ clip: { guid: c.guid! } }]
  const defs: Record<string, AudioEventDefinition> = {
    engine: AudioEvent.deserialize({
      mode: 'sustain',
      parameters: [
        { name: 'rpm', min: 0, max: 9000, initial: 800, smooth: 0.03 },
        { name: 'load', min: -1, max: 1, initial: 0, smooth: 0.1 },
      ],
      layers: [
        {
          id: 'engine',
          loop: true,
          choices: choice(engine),
          curves: [
            // Pitch follows rpm (12 semitones per doubling from 800).
            {
              parameter: 'rpm',
              property: 'pitchSemitones',
              points: [
                [400, -12],
                [800, 0],
                [1600, 12],
                [3200, 24],
                [6400, 36],
                [9000, 41.9],
              ],
            },
            {
              parameter: 'load',
              property: 'gainDb',
              points: [
                [-1, -10],
                [0, -6],
                [1, 0],
              ],
            },
            {
              parameter: 'rpm',
              property: 'lowpass',
              points: [
                [800, 1200],
                [7000, 9000],
              ],
            },
          ],
        },
      ],
    }),
    tires: AudioEvent.deserialize({
      mode: 'sustain',
      parameters: [
        { name: 'slip', min: 0, max: 1, initial: 0, smooth: 0.05 },
        { name: 'rollSpeed', min: 0, max: 60, initial: 0, smooth: 0.1 },
        {
          name: 'surface',
          kind: 'label',
          labels: [
            'asphalt',
            'concrete',
            'gravel',
            'dirt',
            'grass',
            'mud',
            'sand',
            'snow',
            'fresh-snow',
            'ice',
          ],
          initial: 0,
        },
      ],
      layers: [
        {
          id: 'roll',
          loop: true,
          choices: choice(roll),
          curves: [
            {
              parameter: 'rollSpeed',
              property: 'gainDb',
              points: [
                [0, -60],
                [3, -24],
                [30, -10],
              ],
            },
          ],
        },
        {
          id: 'skid',
          loop: true,
          choices: choice(skid),
          curves: [
            {
              parameter: 'slip',
              property: 'gainDb',
              points: [
                [0, -60],
                [0.2, -30],
                [1, -4],
              ],
            },
          ],
        },
        {
          id: 'gravel',
          loop: true,
          choices: choice(gravel),
          trigger: 'while',
          condition: { parameter: 'surface', min: 0, max: 0, label: 'gravel' },
          curves: [
            {
              parameter: 'rollSpeed',
              property: 'gainDb',
              points: [
                [0, -60],
                [2, -18],
                [20, -6],
              ],
            },
          ],
        },
      ],
    }),
    shift: AudioEvent.deserialize({ layers: [{ id: 'clunk', choices: choice(clunk) }] }),
  }
  const server = assetServer(world)
  const store = world.initResource(AudioEvent.store)
  const refs: Record<string, AssetRef<'audio/AudioEvent'>> = {}
  for (const [name, def] of Object.entries(defs)) {
    const guid = `playground:vehicle-${name}`
    const path = `playground/vehicle-${name}.audio-event.json`
    store.set(guid, def as never)
    server.virtual(guid, path, AudioEvent.type.name, () => def)
    refs[name] = { type: 'audio/AudioEvent', guid, path }
  }
  await Promise.all(Object.values(refs).map((r) => prepareAudio(world, r)))
  return refs
}

function spriteOf(world: World): { guid: string } {
  const size = 64
  const data = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(((x + 0.5) / size) * 2 - 1, ((y + 0.5) / size) * 2 - 1)
      const k = Math.max(0, 1 - d)
      const o = (y * size + x) * 4
      data[o] = data[o + 1] = data[o + 2] = 255
      data[o + 3] = Math.round(k * k * (3 - 2 * k) * 255)
    }
  const ref = world
    .resource(Textures)
    .add(
      Texture.create({ width: size, height: size, mips: [data] }),
      'playground:vehicle-puff',
    ) as AssetRef
  return { guid: ref.guid! }
}

function makeEffects(world: World): Record<string, AssetRef<'ParticleEffect'>> {
  const texture = spriteOf(world)
  const puff = (
    color: [number, number, number],
    size: [number, number],
    life: [number, number],
    up: number,
    rate = 60,
  ) =>
    world.resource(ParticleEffects).add(
      ParticleEffect.fromJson({
        emitters: [
          {
            name: 'puff',
            capacity: 256,
            spawn: { rate },
            shape: { type: 'sphere', radius: 0.15 },
            init: { lifetime: life, speed: [0.3, 1.2], size, color: [...color, 0.7] },
            update: [
              { module: 'velocity-over-life', velocity: [0, up, 0] },
              { module: 'drag', coefficient: 1.5 },
              {
                module: 'size-over-life',
                curve: [
                  [0, 0.6],
                  [1, 2],
                ],
              },
              {
                module: 'color-over-life',
                gradient: [
                  [0, [...color], 0.6],
                  [1, [...color], 0],
                ],
              },
            ],
            render: { blend: 'alpha', texture },
          },
        ],
      } as never),
    ) as AssetRef<'ParticleEffect'>
  return {
    dust: puff([0.55, 0.5, 0.42], [0.3, 0.6], [0.8, 1.6], 0.4),
    sand: puff([0.82, 0.72, 0.5], [0.3, 0.7], [0.8, 1.8], 0.3, 90),
    mud: puff([0.25, 0.17, 0.08], [0.12, 0.25], [0.4, 0.8], -2),
    snow: puff([0.95, 0.96, 1], [0.2, 0.45], [0.6, 1.2], 0.2, 90),
    grass: puff([0.3, 0.45, 0.2], [0.08, 0.16], [0.3, 0.6], -1, 30),
    smoke: puff([0.8, 0.8, 0.82], [0.5, 1], [1.2, 2.4], 0.8, 80),
  }
}

// --- the plugin ----------------------------------------------------------------------------

function setAssists(world: World, index: number) {
  demo.assists = index
  for (const car of demo.cars) {
    if (!world.isAlive(car)) continue
    const preset = ASSISTS[index]!
    if (preset === 'none')
      world.set(car, VehicleAssists, {
        preset: 'custom',
        abs: 0,
        tcs: 0,
        esc: 0,
        counterSteer: 0,
        driftGrip: 1,
        driftHold: 0,
        downforce: 0,
        airControl: [0, 0, 0],
        selfRight: false,
        antiFlip: 0,
      })
    else world.set(car, VehicleAssists, { preset })
  }
}

function resetCar(world: World) {
  if (!world.isAlive(demo.car)) return
  const t = world.get(demo.car, Transform)
  const [qx, qy, qz, qw] = t.rotation
  const yaw = Math.atan2(2 * (qw * qy + qx * qz), 1 - 2 * (qy * qy + qx * qx))
  world.set(demo.car, Transform, {
    translation: [t.translation[0], t.translation[1] + 1.5, t.translation[2]],
    rotation: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)],
  })
  world.set(demo.car, Velocity, { linear: [0, 0, 0], angular: [0, 0, 0] })
}

async function runTest(world: World) {
  if (demo.testing || !world.isAlive(demo.car)) return
  demo.testing = true
  demo.report = undefined
  try {
    demo.report = await testTemplate(captureVehicle(world, demo.car), {
      maneuvers: ['accel', 'brake', 'skidpad', 'step', 'top'],
    })
  } finally {
    demo.testing = false
  }
}

export const vehiclesDemoPlugin = definePlugin({
  name: 'vehicles-demo',
  dependencies: ['vehicle'],
  build(app) {
    app.addSystems(Update, drive)
    app.addSystems(Update, hits)
    app.addSystems(PostUpdate, chaseCamera.before(TransformSystems))
  },
  async ready(app: App) {
    const world = app.world
    demo.scenario = scenarioOf()
    world.resource(PhysicsConfig).interpolate = true
    world.resource(AmbientLight).brightness = 2400
    world.spawn(
      [DirectionalLight, { illuminance: 60_000, shadows: true }],
      [Transform, { rotation: quat.fromEuler([0, 0, 0, 1], -0.9, 0.6, 0) as never }],
    )
    demo.camera = world.spawn(
      [Camera3d, { fovY: 60, far: 2000, clearColor: [0.55, 0.68, 0.85, 1] }],
      [Exposure, { ev100: 14.2 }],
      [Transform, { translation: [0, 3, 10] }],
    )
    // A wide grass field around every scenario, just under its ground, so nothing falls forever.
    visual(world, plane({ size: 3000 }), [0.3, 0.36, 0.25], [0, -0.05, 0])
    for (let i = -6; i < 6; i++)
      for (let j = -6; j < 6; j++) {
        world.spawn(
          [RigidBody, { kind: 'fixed' }],
          [
            Collider,
            { shape: 'cuboid', halfExtents: [50, 0.5, 50], surface: surfacePreset('grass') },
          ],
          [Transform, { translation: [i * 100 + 50, -0.55, j * 100 + 50] }],
        )
      }
    try {
      demo.audio = await makeAudio(world)
    } catch (err) {
      console.warn('vehicles demo: no audio', err)
    }
    try {
      demo.effects = makeEffects(world)
    } catch (err) {
      console.warn('vehicles demo: no effects', err)
    }
    switch (demo.scenario) {
      case 'proving':
        proving(world)
        break
      case 'surfaces':
        surfaces(world)
        break
      case 'hills':
        hillsScenario(world)
        break
      case 'drift':
        drift(world)
        break
      case 'offroad':
        offroad(world)
        break
      case 'horde':
        horde(world)
        break
      case 'garage':
        garage(world)
        break
    }
    // Cars in this scenario drive with the chosen assists (the drift pad keeps arcade).
    if (demo.scenario !== 'drift') setAssists(world, demo.assists)
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
      demo.keys.add(e.code)
      demo.scripted = false
      demo.scripted = false
      if (e.code.startsWith('Digit')) {
        const n = Number(e.code.slice(5))
        const s = SCENARIOS[n - 1]
        if (s) {
          const url = new URL(location.href)
          url.searchParams.set('scenario', s[0])
          location.href = url.toString()
        }
      } else if (e.code === 'KeyC') {
        demo.chase = !demo.chase
        chaseReady = false
        if (!demo.chase && world.isAlive(demo.car)) {
          const p = world.get(demo.car, GlobalTransform).matrix
          world.add(
            demo.camera,
            ...(orbitFrom([p[3]! + 8, p[7]! + 5, p[11]! + 8], [p[3]!, p[7]!, p[11]!]) as [
              typeof OrbitControls,
              object,
            ]),
          )
        } else if (world.has(demo.camera, OrbitControls)) world.remove(demo.camera, OrbitControls)
      } else if (e.code === 'KeyO') {
        demo.overlay = !demo.overlay
        setOverlays(world, { vehicles: demo.overlay, colliders: demo.overlay })
      } else if (e.code === 'KeyP') setAssists(world, (demo.assists + 1) % ASSISTS.length)
      else if (e.code === 'KeyR') resetCar(world)
      else if (e.code === 'KeyT') void runTest(world)
      else if (e.code === 'KeyB') {
        const rc = world.resource(RoadConditions)
        rc.wetness = rc.wetness > 0 ? 0 : 1
      } else if (e.code === 'KeyM' && world.isAlive(demo.car)) {
        const tr = world.get(demo.car, VehicleTransmission)
        world.set(demo.car, VehicleTransmission, {
          mode: tr.mode === 'manual' ? 'automatic' : 'manual',
        })
      } else if ((e.code === 'KeyE' || e.code === 'KeyQ') && world.isAlive(demo.car)) {
        world.set(demo.car, VehicleInput, { shift: e.code === 'KeyE' ? 1 : -1 })
      } else if (e.code === 'Tab') {
        e.preventDefault()
        const i = demo.cars.indexOf(demo.car)
        demo.car = demo.cars[(i + 1) % demo.cars.length]!
        chaseReady = false
      }
    })
    window.addEventListener('keyup', (e) => demo.keys.delete(e.code))
    window.addEventListener('blur', () => demo.keys.clear())
    ;(window as unknown as { vehiclesDemo: object }).vehiclesDemo = {
      scenario: () => demo.scenario,
      state: () => (world.isAlive(demo.car) ? world.get(demo.car, VehicleState) : null),
      drive: (input: Record<string, number> | null) => {
        demo.scripted = input !== null
        if (input) world.set(demo.car, VehicleInput, input)
      },
      describe: () =>
        world.isAlive(demo.car)
          ? world
              .resource(VehicleSimsResource)
              .sims.get(demo.car)
              ?.wheels.map((w) => ({ grounded: w.grounded, surface: w.surface, load: w.load }))
          : null,
      test: () => runTest(world),
      report: () => demo.report,
      hits: () => demo.hits,
    }
    hudExtras.push(hudLines)
  },
})
