import {
  type AssetRef,
  ChildOf,
  defineSystem,
  type Entity,
  quat,
  Rng,
  Update,
  type World,
} from '@aethervtt/shard-core'
import { capsule, cube, cylinder, plane, sphere } from '@aethervtt/shard-mesh'
import {
  CharacterController,
  CharacterIntent,
  CharacterState,
  Collider,
  GravitySource,
  Mass,
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

type Mode = 'course' | 'planet'
type Vec3 = [number, number, number]
type MeshStore = { add(mesh: import('@aethervtt/shard-mesh').Mesh): AssetRef<'Mesh'> }
type Mat = (value: ConstructorParameters<typeof MaterialAsset>[0]) => AssetRef<'Material'>

interface Walker {
  entity: Entity
  /** Turn rate, rad/s; changes now and then. */
  turn: number
  next: number
}

interface Demo {
  mode: Mode
  player: Entity
  camera: Entity
  eye: Vec3 | undefined
  keys: Set<string>
  walkers: Walker[]
  rng: Rng
  movers: { elevator: Entity; shuttle: Entity } | undefined
}

let demo: Demo | undefined

const PLANET_RADIUS = 12
const WALK = 3.5
const RUN = 7
const TURN = 2.4

/** A quaternion turning +Y onto the unit vector n (shortest arc). */
function upTo(n: Vec3): [number, number, number, number] {
  const [x, y, z] = n
  if (y < -0.9999) return [1, 0, 0, 0]
  const q: [number, number, number, number] = [z, 0, -x, 1 + y]
  const len = Math.hypot(...q)
  return [q[0] / len, q[1] / len, q[2] / len, q[3] / len]
}

/** Rotates q in place by `angle` around the world axis `axis`. */
function turnAround(q: number[], axis: ArrayLike<number>, angle: number): number[] {
  const s = Math.sin(angle / 2)
  const turn = [axis[0]! * s, axis[1]! * s, axis[2]! * s, Math.cos(angle / 2)]
  return quat.normalize(q, quat.multiply(q, turn, q))
}

/** Rotates v by quaternion q. */
function rotate(q: ArrayLike<number>, v: Vec3): Vec3 {
  const [qx, qy, qz, qw] = [q[0]!, q[1]!, q[2]!, q[3]!]
  const tx = 2 * (qy * v[2] - qz * v[1])
  const ty = 2 * (qz * v[0] - qx * v[2])
  const tz = 2 * (qx * v[1] - qy * v[0])
  return [
    v[0] + qw * tx + (qy * tz - qz * ty),
    v[1] + qw * ty + (qz * tx - qx * tz),
    v[2] + qw * tz + (qx * ty - qy * tx),
  ]
}

/**
 * Player input into CharacterIntent (W/S walk, A/D turn, Q/E strafe, shift runs, space jumps),
 * and the NPCs' wandering. Turning writes the rotation around the character's up.
 */
const steer = defineSystem({
  name: 'character-demo/steer',
  run: (_, world) => {
    const d = demo
    if (!d) return
    const dt = world.resource(Time).delta
    const k = d.keys
    const held = (...codes: string[]) => codes.some((c) => k.has(c))
    const speed = held('ShiftLeft', 'ShiftRight') ? RUN : WALK
    const forward = (held('KeyW', 'ArrowUp') ? 1 : 0) - (held('KeyS', 'ArrowDown') ? 1 : 0)
    const side = (held('KeyE') ? 1 : 0) - (held('KeyQ') ? 1 : 0)
    const turn = (held('KeyA', 'ArrowLeft') ? 1 : 0) - (held('KeyD', 'ArrowRight') ? 1 : 0)
    const intent = world.get(d.player, CharacterIntent)
    world.set(d.player, CharacterIntent, {
      move: [side * speed, 0, -forward * speed],
      jump: intent.jump || k.has('Space'),
    })
    k.delete('Space')
    if (turn !== 0) turnEntity(world, d.player, turn * TURN * dt)

    const time = world.resource(Time).elapsed
    for (const w of d.walkers) {
      if (time > w.next) {
        w.turn = d.rng.range(-1.2, 1.2)
        w.next = time + d.rng.range(1, 4)
        if (d.rng.float() < 0.3)
          world.set(w.entity, CharacterIntent, { move: [0, 0, -2], jump: true })
      }
      turnEntity(world, w.entity, w.turn * dt)
    }

    if (d.movers) {
      // The elevator rises 3 m and back; the shuttle slides between the two landings.
      const elevator = 0.25 + 1.5 * (1 - Math.cos(time * 0.6))
      world.set(d.movers.elevator, Transform, { translation: [14, elevator, -14] })
      const shuttle = Math.sin(time * 0.5) * 5
      world.set(d.movers.shuttle, Transform, { translation: [shuttle, 1.25, -24] })
    }
  },
})

function turnEntity(world: World, e: Entity, angle: number): void {
  const up = world.get(e, CharacterState).up
  const rotation = [...world.get(e, Transform).rotation]
  world.set(e, Transform, { rotation: turnAround(rotation, up, angle) as never })
}

/** A camera behind and above the player, in its frame, so it follows it around a planet too. */
const follow = defineSystem({
  name: 'character-demo/camera',
  run: (_, world) => {
    const d = demo
    if (!d) return
    const { translation, rotation } = world.get(d.player, Transform)
    const up = [...world.get(d.player, CharacterState).up] as Vec3
    const offset = rotate(rotation, [0, 2.4, 6.5])
    const want: Vec3 = [
      translation[0] + offset[0],
      translation[1] + offset[1],
      translation[2] + offset[2],
    ]
    const k = 1 - Math.exp(-6 * world.resource(Time).delta)
    const eye = d.eye ?? want
    for (let i = 0; i < 3; i++) eye[i] = eye[i]! + (want[i]! - eye[i]!) * k
    d.eye = eye
    const target: Vec3 = [
      translation[0] + up[0] * 0.8,
      translation[1] + up[1] * 0.8,
      translation[2] + up[2] * 0.8,
    ]
    world.set(d.camera, Transform, { translation: [...eye], rotation: lookAt(eye, target, up) })
  },
})

function build(mode: Mode) {
  return definePlugin({
    name: `character-demo/${mode}`,
    dependencies: ['render/forward', 'physics3d'],
    build(app) {
      app.addSystems(Update, steer, follow)
      hudExtras.push((world) => {
        const d = demo
        if (!d) return []
        const s = world.get(d.player, CharacterState)
        const [vx, vy, vz] = s.velocity
        const [ux, uy, uz] = s.up
        return [
          `player    ${s.grounded ? 'grounded' : `airborne ${s.airTime.toFixed(1)} s`}, ${Math.hypot(vx, vy, vz).toFixed(1)} m/s`,
          `up        ${ux.toFixed(2)}, ${uy.toFixed(2)}, ${uz.toFixed(2)}`,
          `wasd: walk and turn   q/e: strafe   shift: run   space: jump   c: colliders`,
        ]
      })
    },
    ready(app) {
      const world = app.world
      const meshes = world.resource(Meshes)
      const materials = world.resource(Materials)
      const mat: Mat = (value) => materials.add(new MaterialAsset(value))

      world.resource(AmbientLight).brightness = 900
      world.spawn(
        [DirectionalLight, { illuminance: 60_000, shadows: true }],
        [Transform, { rotation: quat.fromEuler([0, 0, 0, 1], -0.9, 0.5, 0) as never }],
      )
      const camera = world.spawn(
        [Camera3d, { fovY: 60, clearColor: [0.03, 0.035, 0.05, 1] }],
        [Exposure, { ev100: 13 }],
        [Transform, { translation: [0, 4, 8] }],
      )

      const body = meshes.add(capsule({ radius: 0.35, height: 1.8, segments: 20, rings: 6 }))
      const visor = meshes.add(cube({ size: 1 }))
      const dark = mat({ baseColor: [0.08, 0.08, 0.1, 1], roughness: 0.3 })
      const spawnCharacter = (at: Vec3, rotation: number[], color: AssetRef<'Material'>) => {
        const e = world.spawn(
          [CharacterController, { up: 'gravity' }],
          [Mesh3d, { mesh: body }],
          [MeshMaterial, { material: color }],
          [Transform, { translation: at, rotation: rotation as never }],
        )
        // A visor on the front (-z) shows which way it faces.
        world.spawn(
          [Mesh3d, { mesh: visor }],
          [MeshMaterial, { material: dark }],
          [Transform, { translation: [0, 0.5, -0.3], scale: [0.4, 0.15, 0.15] }],
          [ChildOf, { parent: e }],
        )
        return e
      }

      const rng = new Rng(5)
      const walkers: Walker[] = []
      const npc = mat({ baseColor: [0.9, 0.6, 0.2, 1], roughness: 0.6 })
      let player: Entity
      let movers: Demo['movers']
      const hero = mat({ baseColor: [0.25, 0.6, 0.95, 1], roughness: 0.4 })
      if (mode === 'course') {
        movers = spawnCourse(world, meshes, mat)
        player = spawnCharacter([0, 1, 6], [0, 0, 0, 1], hero)
        for (let i = 0; i < 10; i++) {
          const at: Vec3 = [rng.range(-8, 8), 1, rng.range(-2, 12)]
          const e = spawnCharacter(at, upTo([0, 1, 0]), npc)
          world.set(e, CharacterIntent, { move: [0, 0, -2] })
          walkers.push({ entity: e, turn: 0, next: 0 })
        }
      } else {
        spawnPlanet(world, meshes, mat, rng)
        const top: Vec3 = [0, PLANET_RADIUS + 1, 0]
        player = spawnCharacter(top, [0, 0, 0, 1], hero)
        for (let i = 0; i < 12; i++) {
          const n = randomDirection(rng)
          const at: Vec3 = [
            n[0] * (PLANET_RADIUS + 1),
            n[1] * (PLANET_RADIUS + 1),
            n[2] * (PLANET_RADIUS + 1),
          ]
          const e = spawnCharacter(at, upTo(n), npc)
          world.set(e, CharacterIntent, { move: [0, 0, -2] })
          walkers.push({ entity: e, turn: 0, next: 0 })
        }
      }

      demo = {
        mode,
        player,
        camera,
        eye: undefined,
        keys: new Set(),
        walkers,
        rng,
        movers,
      }
      window.addEventListener('keydown', (event) => {
        if (event.code === 'Space') event.preventDefault()
        if (event.repeat) return
        demo?.keys.add(event.code)
        if (event.code === 'KeyC') {
          const on = isOverlayOn(world.resource(DebugOverlays), 'colliders')
          setOverlays(world, { colliders: !on })
        }
      })
      window.addEventListener('keyup', (event) => {
        if (event.code !== 'Space') demo?.keys.delete(event.code)
      })
      window.addEventListener('blur', () => demo?.keys.clear())
    },
  })
}

function randomDirection(rng: Rng): Vec3 {
  for (;;) {
    const v: Vec3 = [rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)]
    const len = Math.hypot(...v)
    if (len > 0.2 && len <= 1) return [v[0] / len, v[1] / len, v[2] / len]
  }
}

/**
 * A fixed box from a unit cube scaled to size (a Transform's scale scales its collider too),
 * optionally tilted around X (ramps) and moved by kinematic kind.
 */
function block(
  world: World,
  mesh: AssetRef<'Mesh'>,
  material: AssetRef<'Material'>,
  at: Vec3,
  size: Vec3,
  rotation: number[] = [0, 0, 0, 1],
  kind: 'fixed' | 'kinematic-position' | 'kinematic-velocity' = 'fixed',
): Entity {
  return world.spawn(
    [RigidBody, { kind }],
    [Collider, { shape: 'cuboid', halfExtents: [0.5, 0.5, 0.5], friction: 0.7 }],
    [Mesh3d, { mesh }],
    [MeshMaterial, { material }],
    [Transform, { translation: at, rotation: rotation as never, scale: size }],
  )
}

/** A ramp rising toward -z at `degrees`, its low edge at (x, 0, z). */
function ramp(
  world: World,
  mesh: AssetRef<'Mesh'>,
  material: AssetRef<'Material'>,
  x: number,
  z: number,
  degrees: number,
  length: number,
): void {
  const a = (degrees * Math.PI) / 180
  const t = 0.4
  const half = length / 2
  block(
    world,
    mesh,
    material,
    [x, Math.sin(a) * half - (Math.cos(a) * t) / 2, z - Math.cos(a) * half - (Math.sin(a) * t) / 2],
    [3, t, length],
    [Math.sin(a / 2), 0, 0, Math.cos(a / 2)],
  )
}

/**
 * The course: stairs, a row of steps that get too tall, walkable and too-steep ramps, an elevator
 * and a shuttle (kinematic by Transform), a spinning disc (kinematic by velocity), and crates.
 */
function spawnCourse(world: World, meshes: MeshStore, mat: Mat): Demo['movers'] {
  const unit = meshes.add(cube({ size: 1 }))
  const floor = mat({ baseColor: [0.32, 0.34, 0.38, 1], roughness: 0.85 })
  const stone = mat({ baseColor: [0.55, 0.56, 0.6, 1], roughness: 0.8 })
  const ok = mat({ baseColor: [0.3, 0.65, 0.4, 1], roughness: 0.7 })
  const steep = mat({ baseColor: [0.8, 0.3, 0.25, 1], roughness: 0.7 })
  const metal = mat({ baseColor: [0.75, 0.78, 0.82, 1], metallic: 1, roughness: 0.35 })
  const wood = mat({ baseColor: [0.6, 0.42, 0.25, 1], roughness: 0.8 })

  world.spawn(
    [RigidBody, { kind: 'fixed' }],
    [Collider, { shape: 'cuboid', halfExtents: [40, 0.5, 40] }],
    [Transform, { translation: [0, -0.5, 0] }],
  )
  world.spawn(
    [Mesh3d, { mesh: meshes.add(plane({ size: 80 })) }],
    [MeshMaterial, { material: floor }],
    Transform,
  )

  // Stairs: ten 0.25 m steps up to a landing.
  for (let i = 0; i < 10; i++) {
    const h = (i + 1) * 0.25
    block(world, unit, stone, [-12, h / 2, -4 - i * 0.6], [3, h, 0.6])
  }
  block(world, unit, stone, [-12, 1.25, -12], [3, 2.5, 4.4])
  // Steps of 0.1 to 0.5 m: it climbs up to stepHeight (0.3 m), and stops at the rest.
  ;[0.1, 0.2, 0.3, 0.4, 0.5].forEach((h, i) => {
    block(world, unit, h <= 0.3 ? ok : steep, [-5 + i * 1.6, h / 2, -6], [1.2, h, 1.2])
  })
  // Ramps: 30° and 40° walk up; 55° is past maxSlope, so it slides back down.
  ramp(world, unit, ok, 4, -4, 30, 8)
  ramp(world, unit, ok, 8, -4, 40, 6)
  ramp(world, unit, steep, 12, -4, 55, 5)

  // The elevator lifts to a high landing; the shuttle crosses between two ledges.
  const elevator = block(
    world,
    unit,
    metal,
    [14, 0.25, -14],
    [3, 0.5, 3],
    undefined,
    'kinematic-position',
  )
  block(world, unit, stone, [14, 1.75, -18.5], [5, 3.5, 6])
  block(world, unit, stone, [-9, 1, -24], [4, 2, 4])
  block(world, unit, stone, [9, 1, -24], [4, 2, 4])
  const shuttle = block(
    world,
    unit,
    metal,
    [0, 1.25, -24],
    [3, 0.5, 3],
    undefined,
    'kinematic-position',
  )
  // A disc spinning on its own: it carries whoever stands on it around.
  world.spawn(
    [RigidBody, { kind: 'kinematic-velocity' }],
    [Collider, { shape: 'cylinder', radius: 3, halfHeight: 0.15, friction: 0.7 }],
    [Velocity, { angular: [0, 0.8, 0] }],
    [Mesh3d, { mesh: meshes.add(cylinder({ radius: 3, height: 0.3, segments: 40 })) }],
    [MeshMaterial, { material: metal }],
    [Transform, { translation: [-12, 0.15, 8] }],
  )

  // Crates (10 kg) and balls to push around.
  const crate = meshes.add(cube({ size: 1 }))
  for (let i = 0; i < 12; i++) {
    world.spawn(
      [RigidBody, { kind: 'dynamic' }],
      [Collider, { shape: 'cuboid', halfExtents: [0.4, 0.4, 0.4], friction: 0.5 }],
      [Mass, { mass: 10 }],
      [Mesh3d, { mesh: crate }],
      [MeshMaterial, { material: wood }],
      [
        Transform,
        {
          translation: [6 + (i % 4) * 1.1, 0.4 + Math.floor(i / 4) * 0.8, 6],
          scale: [0.8, 0.8, 0.8],
        },
      ],
    )
  }
  const ball = meshes.add(sphere({ radius: 0.5, segments: 20, rings: 12 }))
  for (let i = 0; i < 4; i++) {
    world.spawn(
      [RigidBody, { kind: 'dynamic', linearDamping: 0.3, angularDamping: 0.3 }],
      [Collider, { shape: 'ball', radius: 0.5, restitution: 0.4 }],
      [Mesh3d, { mesh: ball }],
      [MeshMaterial, { material: mat({ baseColor: [0.9, 0.85, 0.3, 1], roughness: 0.4 }) }],
      [Transform, { translation: [-4 + i * 1.5, 0.5, 10] }],
    )
  }
  return { elevator, shuttle }
}

/** A small planet with its own gravity (and none elsewhere), dotted with rocks and pillars. */
function spawnPlanet(world: World, meshes: MeshStore, mat: Mat, rng: Rng): void {
  world.resource(PhysicsConfig).gravity = [0, 0, 0]
  world.spawn(
    [RigidBody, { kind: 'fixed' }],
    [Collider, { shape: 'ball', radius: PLANET_RADIUS, friction: 0.8 }],
    [GravitySource, { strength: 9.81, radius: PLANET_RADIUS }],
    [Mesh3d, { mesh: meshes.add(sphere({ radius: PLANET_RADIUS, segments: 96, rings: 48 })) }],
    [MeshMaterial, { material: mat({ baseColor: [0.3, 0.5, 0.36, 1], roughness: 0.9 }) }],
    Transform,
  )
  const unit = meshes.add(cube({ size: 1 }))
  const rock = mat({ baseColor: [0.5, 0.48, 0.45, 1], roughness: 0.9 })
  const crystal = mat({ baseColor: [0.4, 0.7, 0.95, 1], roughness: 0.2, metallic: 0.2 })
  for (let i = 0; i < 40; i++) {
    const n = randomDirection(rng)
    // Keep the start clear.
    if (n[1] > 0.95) continue
    const tall = rng.float() < 0.25
    const size: Vec3 = tall
      ? [0.8, rng.range(2, 4), 0.8]
      : [rng.range(0.6, 1.6), rng.range(0.2, 0.3), rng.range(0.6, 1.6)]
    const r = PLANET_RADIUS + size[1] / 2 - 0.05
    block(world, unit, tall ? crystal : rock, [n[0] * r, n[1] * r, n[2] * r], size, upTo(n))
  }
}

/** A walking course: stairs, steps, ramps, moving and spinning platforms, crates, and NPCs. */
export const characterDemoPlugin = build('course')
/** Walking around a small planet: up comes from its GravitySource, so the player turns with it. */
export const characterPlanetDemoPlugin = build('planet')
