import { type AssetRef, defineSystem, type Entity, quat, Rng, Update } from '@aethervtt/shard-core'
import { capsule, cube, plane, sphere } from '@aethervtt/shard-mesh'
import {
  Collider,
  ExternalImpulse,
  GravitySource,
  Joint,
  Physics,
  PhysicsConfig,
  RigidBody,
  Velocity,
} from '@aethervtt/shard-physics'
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
  setOverlays,
} from '@aethervtt/shard-render'
import { definePlugin, Time } from '@aethervtt/shard-runtime'
import { lookAt, Transform } from '@aethervtt/shard-transform'
import { hudExtras } from './hud'

type Mode = 'ground' | 'planet' | 'flat'

interface Shapes {
  meshes: AssetRef<'Mesh'>[]
  materials: AssetRef<'Material'>[]
  colliders: Record<string, unknown>[]
}

interface Demo {
  mode: Mode
  cap: number
  perFrame: number
  bodies: Entity[]
  next: number
  rng: Rng
  shapes: Shapes
  camera: Entity
  explode: boolean
  /** Keep recycling the oldest bodies once the cap is reached (R toggles). */
  raining: boolean
}

let demo: Demo | undefined

const PALETTE: [number, number, number, number][] = [
  [0.9, 0.35, 0.15, 1],
  [0.95, 0.75, 0.2, 1],
  [0.2, 0.55, 0.9, 1],
  [0.3, 0.8, 0.45, 1],
  [0.85, 0.85, 0.88, 1],
]

const PLANET_RADIUS = 6

/** Where the next body starts: above the ground, or on a shell around the planet. */
function spawnPoint(d: Demo): { at: [number, number, number]; velocity: [number, number, number] } {
  const r = d.rng
  if (d.mode === 'flat') {
    return { at: [r.range(-14, 14), r.range(18, 26), 0], velocity: [0, r.range(-2, 0), 0] }
  }
  if (d.mode === 'ground') {
    return {
      at: [r.range(-10, 10), r.range(14, 22), r.range(-10, 10)],
      velocity: [0, r.range(-2, 0), 0],
    }
  }
  // A random direction, 16–24 m out, with a little sideways drift so rocks swirl in.
  let x = 0
  let y = 0
  let z = 0
  let len = 0
  do {
    x = r.range(-1, 1)
    y = r.range(-1, 1)
    z = r.range(-1, 1)
    len = Math.sqrt(x * x + y * y + z * z)
  } while (len < 0.2 || len > 1)
  const dist = r.range(16, 24)
  x /= len
  y /= len
  z /= len
  return {
    at: [x * dist, y * dist, z * dist],
    velocity: [-z * 2, 0, x * 2],
  }
}

function randomRotation(r: Rng, flat: boolean): [number, number, number, number] {
  if (flat) {
    const a = r.range(0, 6.28)
    return [0, 0, Math.sin(a / 2), Math.cos(a / 2)]
  }
  return quat.fromEuler([0, 0, 0, 1], r.range(0, 6.28), r.range(0, 6.28), r.range(0, 6.28)) as [
    number,
    number,
    number,
    number,
  ]
}

/**
 * Drops bodies until the cap, then recycles the oldest: teleporting a dynamic body is just writing
 * its Transform (and its Velocity), which physics picks up at the next step.
 */
const spawner = defineSystem({
  name: 'physics-demo/spawn',
  run: (_, world) => {
    const d = demo
    if (!d) return
    for (let i = 0; i < d.perFrame; i++) {
      const { at, velocity } = spawnPoint(d)
      if (d.bodies.length < d.cap) {
        const kind = d.bodies.length % d.shapes.meshes.length
        const e = world.spawn(
          [RigidBody, { kind: 'dynamic' }],
          [Collider, d.shapes.colliders[kind]!],
          [Velocity, { linear: velocity }],
          [ExternalImpulse, {}],
          [Mesh3d, { mesh: d.shapes.meshes[kind]! }],
          [MeshMaterial, { material: d.shapes.materials[d.bodies.length % PALETTE.length]! }],
          [Transform, { translation: at, rotation: randomRotation(d.rng, d.mode === 'flat') }],
        )
        d.bodies.push(e)
        continue
      }
      if (!d.raining) break
      const e = d.bodies[d.next]!
      d.next = (d.next + 1) % d.bodies.length
      world.set(e, Transform, {
        translation: at,
        rotation: randomRotation(d.rng, d.mode === 'flat'),
      })
      world.set(e, Velocity, { linear: velocity, angular: [0, 0, 0] })
    }
    if (d.explode) {
      d.explode = false
      // Every body within 15 m of the center gets pushed out (and up, on the ground).
      for (const e of d.bodies) {
        const [x, y, z] = world.get(e, Transform).translation
        const dy = d.mode === 'planet' ? y : y + (d.mode === 'flat' ? 2 : 4)
        const dist = Math.sqrt(x * x + dy * dy + z * z) || 1
        if (dist > 15) continue
        const strength = 25 * (1 - dist / 15)
        world.set(e, ExternalImpulse, {
          impulse: [(x / dist) * strength, (dy / dist) * strength, (z / dist) * strength],
        })
      }
    }
  },
})

/** Circles the camera around the action. */
const orbitCamera = defineSystem({
  name: 'physics-demo/camera',
  run: (_, world) => {
    const d = demo
    if (!d || d.mode === 'flat') return
    const t = world.resource(Time).elapsed * 0.1
    const radius = d.mode === 'ground' ? 38 : 55
    const height = d.mode === 'ground' ? 18 : 12
    const eye: [number, number, number] = [Math.sin(t) * radius, height, Math.cos(t) * radius]
    const target: [number, number, number] = d.mode === 'ground' ? [0, 3, 0] : [0, 0, 0]
    world.set(d.camera, Transform, { translation: eye, rotation: lookAt(eye, target) })
  },
})

function build(mode: Mode) {
  return definePlugin({
    name: `physics-demo/${mode}`,
    dependencies: ['render/forward', mode === 'flat' ? 'physics2d' : 'physics3d'],
    build(app) {
      app.addSystems(Update, spawner, orbitCamera)
      hudExtras.push((world) => {
        const p = world.tryResource(Physics)
        if (!p) return []
        const s = p.describe()
        return [
          `bodies    ${(s.bodies.dynamic ?? 0).toLocaleString()} dynamic, ${s.sleeping.toLocaleString()} asleep`,
          `contacts  ${Math.round(s.contacts).toLocaleString()} pairs, step ${s.stepMs.toFixed(2)} ms`,
          `space: explode   r: rain ${demo?.raining ? 'on' : 'off'}   c: colliders`,
        ]
      })
    },
    ready(app) {
      const world = app.world
      const params = new URLSearchParams(location.search)
      const meshes = world.resource(Meshes)
      const materials = world.resource(Materials)
      const mat = (value: ConstructorParameters<typeof MaterialAsset>[0]) =>
        materials.add(new MaterialAsset(value))

      world.resource(AmbientLight).brightness = 800
      world.spawn(
        [DirectionalLight, { illuminance: 60_000, shadows: true }],
        [Transform, { rotation: quat.fromEuler([0, 0, 0, 1], -0.9, 0.6, 0) as never }],
      )
      const flat = mode === 'flat'
      const camera = world.spawn(
        [
          Camera3d,
          flat
            ? { projection: 'orthographic', orthoHeight: 30, clearColor: [0.02, 0.025, 0.04, 1] }
            : { fovY: 50, clearColor: [0.02, 0.025, 0.04, 1] },
        ],
        [Exposure, { ev100: 13 }],
        flat
          ? [Transform, { translation: [0, 10, 50] }]
          : [Transform, { translation: [0, 14, 30], rotation: lookAt([0, 14, 30], [0, 3, 0]) }],
      )

      const shapes: Shapes = {
        meshes: [
          meshes.add(cube({ size: 1 })),
          meshes.add(sphere({ radius: 0.5, segments: 16, rings: 10 })),
          meshes.add(capsule({ radius: 0.3, height: 1.4, segments: 12, rings: 4 })),
        ],
        materials: PALETTE.map((baseColor) => mat({ baseColor, roughness: 0.5 })),
        colliders: [
          { shape: 'cuboid', halfExtents: [0.5, 0.5, flat ? 0 : 0.5], friction: 0.6 },
          { shape: 'ball', radius: 0.5, restitution: 0.3 },
          { shape: 'capsule', radius: 0.3, halfHeight: 0.4 },
        ],
      }

      if (flat) {
        spawnFlatLevel(world, meshes.add(cube({ size: 1 })), mat)
      } else if (mode === 'ground') {
        world.spawn(
          [RigidBody, { kind: 'fixed' }],
          [Collider, { shape: 'cuboid', halfExtents: [40, 0.5, 40] }],
          [Transform, { translation: [0, -0.5, 0] }],
        )
        world.spawn(
          [Mesh3d, { mesh: meshes.add(plane({ size: 80 })) }],
          [MeshMaterial, { material: mat({ baseColor: [0.35, 0.36, 0.4, 1], roughness: 0.8 }) }],
          Transform,
        )
        spawnChain(world, meshes.add(capsule({ radius: 0.15, height: 0.8, segments: 10 })), mat)
      } else {
        world.resource(PhysicsConfig).gravity = [0, 0, 0]
        world.spawn(
          [RigidBody, { kind: 'fixed' }],
          [Collider, { shape: 'ball', radius: PLANET_RADIUS, friction: 0.8 }],
          [GravitySource, { strength: 9.81, radius: PLANET_RADIUS }],
          [
            Mesh3d,
            { mesh: meshes.add(sphere({ radius: PLANET_RADIUS, segments: 64, rings: 32 })) },
          ],
          [MeshMaterial, { material: mat({ baseColor: [0.25, 0.45, 0.35, 1], roughness: 0.9 }) }],
          Transform,
        )
      }

      demo = {
        mode,
        cap: Number(params.get('count') ?? (flat ? 350 : 1500)),
        perFrame: 8,
        bodies: [],
        next: 0,
        rng: new Rng(11),
        shapes,
        camera,
        explode: false,
        raining: false,
      }
      window.addEventListener('keydown', (event) => {
        if (event.code === 'Space') {
          event.preventDefault()
          if (demo) demo.explode = true
        } else if (event.code === 'KeyR') {
          if (demo) demo.raining = !demo.raining
        } else if (event.code === 'KeyC') {
          const on = isOverlayOn(world.resource(DebugOverlays), 'colliders')
          setOverlays(world, { colliders: !on })
        }
      })
    },
  })
}

type World = import('@aethervtt/shard-core').World
type Mat = (value: ConstructorParameters<typeof MaterialAsset>[0]) => AssetRef<'Material'>

/**
 * The 2D level, built from unit cubes scaled into slabs (Transform scale scales the collider too):
 * a valley, a bridge of planks joined by revolute joints, and a spinning kinematic paddle.
 */
function spawnFlatLevel(world: World, box: AssetRef<'Mesh'>, mat: Mat): void {
  const rock = mat({ baseColor: [0.4, 0.42, 0.48, 1], roughness: 0.9 })
  const wood = mat({ baseColor: [0.55, 0.38, 0.22, 1], roughness: 0.8 })
  const slab = (
    x: number,
    y: number,
    w: number,
    h: number,
    angle: number,
    kind: 'fixed' | 'kinematic-velocity' = 'fixed',
  ) =>
    world.spawn(
      [RigidBody, { kind }],
      [Collider, { shape: 'cuboid', halfExtents: [0.5, 0.5, 0], friction: 0.7 }],
      [Mesh3d, { mesh: box }],
      [MeshMaterial, { material: kind === 'fixed' ? rock : wood }],
      [
        Transform,
        {
          translation: [x, y, 0],
          rotation: [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)],
          scale: [w, h, 1],
        },
      ],
    )
  // Valley: a floor, two slopes, and walls.
  slab(0, -0.5, 20, 1, 0)
  const slope = Math.atan2(8, 10)
  slab(-15, 3.5, Math.hypot(10, 8), 1, -slope)
  slab(15, 3.5, Math.hypot(10, 8), 1, slope)
  slab(-20.5, 14, 1, 12, 0)
  slab(20.5, 14, 1, 12, 0)
  // A paddle that spins on its own (kinematic by velocity) and flings what lands on it.
  const paddle = slab(-13, 8, 5, 0.3, 0, 'kinematic-velocity')
  world.add(paddle, Velocity, { angular: [0, 0, 1.5] })
  // A bridge of 12 planks between two posts, joined at their ends.
  const left = slab(-6.6, 12, 0.4, 0.4, 0)
  const right = slab(6.6, 12, 0.4, 0.4, 0)
  let previous = left
  for (let i = 0; i < 12; i++) {
    const plank = world.spawn(
      [RigidBody, { kind: 'dynamic' }],
      [Collider, { shape: 'cuboid', halfExtents: [0.5, 0.5, 0], density: 2 }],
      [Mesh3d, { mesh: box }],
      [MeshMaterial, { material: wood }],
      [Transform, { translation: [-5.5 + i, 12, 0], scale: [0.95, 0.2, 1] }],
    )
    world.add(plank, Joint, {
      kind: 'revolute',
      other: previous,
      anchor: [-0.5, 0, 0],
      otherAnchor: [i === 0 ? 0.2 : 0.5, 0, 0],
    })
    previous = plank
  }
  world.add(right, Joint, {
    kind: 'revolute',
    other: previous,
    anchor: [-0.2, 0, 0],
    otherAnchor: [0.5, 0, 0],
  })
}

/** A chain of capsules hanging from a fixed point by spherical joints, kicked sideways. */
function spawnChain(
  world: import('@aethervtt/shard-core').World,
  link: AssetRef<'Mesh'>,
  mat: (value: ConstructorParameters<typeof MaterialAsset>[0]) => AssetRef<'Material'>,
): void {
  const top: [number, number, number] = [-14, 16, 0]
  let previous = world.spawn([RigidBody, { kind: 'fixed' }], [Transform, { translation: top }])
  const steel = mat({ baseColor: [0.8, 0.8, 0.85, 1], metallic: 1, roughness: 0.3 })
  for (let i = 0; i < 16; i++) {
    const y = top[1] - 0.4 - i * 0.8
    const e = world.spawn(
      [RigidBody, { kind: 'dynamic', angularDamping: 0.5 }],
      [Collider, { shape: 'capsule', radius: 0.15, halfHeight: 0.25, density: 4 }],
      [Velocity, { linear: i === 15 ? [12, 0, 4] : [0, 0, 0] }],
      [Mesh3d, { mesh: link }],
      [MeshMaterial, { material: steel }],
      [Transform, { translation: [top[0], y, top[2]] }],
    )
    world.add(e, Joint, {
      kind: 'spherical',
      other: previous,
      anchor: [0, 0.4, 0],
      otherAnchor: [0, i === 0 ? 0 : -0.4, 0],
    })
    previous = e
  }
}

/**
 * 1,500 boxes, balls, and capsules (`?count=`) dropped onto the ground until they settle and
 * sleep, plus a hanging chain. Space explodes the pile, R keeps it raining, C shows colliders.
 */
export const physicsDemoPlugin = build('ground')
/** Rocks falling onto a small planet from every side (point gravity, no global gravity). */
export const planetDemoPlugin = build('planet')
/** The same rain in 2D (physics2d): a valley, a plank bridge on revolute joints, a spinning paddle. */
export const physics2dDemoPlugin = build('flat')
