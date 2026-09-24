import {
  type AssetRef,
  ChildOf,
  defineSystem,
  type Entity,
  quat,
  Rng,
  Update,
  type World,
} from '@shard/core'
import { capsule, cube } from '@shard/mesh'
import {
  CharacterController,
  CharacterIntent,
  CharacterState,
  Collider,
  Mass,
  RigidBody,
  Velocity,
} from '@shard/physics'
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
} from '@shard/render'
import { definePlugin, Time } from '@shard/runtime'
import { Transform } from '@shard/transform'
import { hudExtras } from './hud'

type Vec2 = [number, number]

interface Walker {
  entity: Entity
  visor: Entity
  /** Where it starts, and comes back to after falling off the level. */
  spawn: Vec2
  /** +1 walks right, -1 left. */
  dir: number
  /** When to pick a new direction at random, and when it last turned. */
  next: number
  turned: number
}

interface Demo {
  player: Walker
  camera: Entity
  eye: Vec2 | undefined
  keys: Set<string>
  walkers: Walker[]
  rng: Rng
  shuttle: Entity
  elevator: Entity
  crates: { entity: Entity; spawn: Vec2 }[]
}

let demo: Demo | undefined

const WALK = 4
const RUN = 8
const angleZ = (a: number): [number, number, number, number] => [
  0,
  0,
  Math.sin(a / 2),
  Math.cos(a / 2),
]

/** Puts the visor on the side the character walks toward. */
function face(world: World, w: Walker, dir: number): void {
  if (dir === 0 || dir === w.dir) return
  w.dir = dir
  world.set(w.visor, Transform, { translation: [0.28 * dir, 0.5, 0.2] })
}

/**
 * A/D (or arrows) walk, shift runs, space jumps. NPCs pace, turn around at walls and now and then,
 * and hop. The moving platforms follow their Transforms (kinematic-position).
 */
const steer = defineSystem({
  name: 'character2d-demo/steer',
  run: (_, world) => {
    const d = demo
    if (!d) return
    const k = d.keys
    const held = (...codes: string[]) => codes.some((c) => k.has(c))
    const dir = (held('KeyD', 'ArrowRight') ? 1 : 0) - (held('KeyA', 'ArrowLeft') ? 1 : 0)
    const speed = held('ShiftLeft', 'ShiftRight') ? RUN : WALK
    const jump = world.get(d.player.entity, CharacterIntent).jump || k.has('Space')
    k.delete('Space')
    world.set(d.player.entity, CharacterIntent, { move: [dir * speed, 0, 0], jump })
    face(world, d.player, dir)

    const time = world.resource(Time).elapsed
    respawnIfFallen(world, d.player)
    for (const c of d.crates) {
      if (world.get(c.entity, Transform).translation[1] > -12) continue
      world.set(c.entity, Transform, {
        translation: [c.spawn[0], c.spawn[1], 0],
        rotation: [0, 0, 0, 1],
      })
      world.set(c.entity, Velocity, { linear: [0, 0, 0], angular: [0, 0, 0] })
    }
    for (const w of d.walkers) {
      respawnIfFallen(world, w)
      const s = world.get(w.entity, CharacterState)
      // Blocked (a wall, a step, another character, even while leaning on one): turn around.
      // Not again right after turning, while it's still getting going.
      const stuck = time - w.turned > 0.5 && Math.abs(s.velocity[0]) < 0.2
      if (time > w.next || stuck) {
        face(world, w, stuck ? -w.dir : d.rng.float() < 0.5 ? -1 : 1)
        w.next = time + d.rng.range(2, 5)
        w.turned = time
      }
      world.set(w.entity, CharacterIntent, {
        move: [w.dir * 2.5, 0, 0],
        jump: s.grounded && d.rng.float() < 0.004,
      })
    }

    world.set(d.shuttle, Transform, { translation: [24 + Math.sin(time * 0.6) * 4, 3, 0] })
    world.set(d.elevator, Transform, { translation: [36, 0.8 + 3 * (1 - Math.cos(time * 0.7)), 0] })
  },
})

/**
 * Fell into the gap: back to the start. Writing the Transform teleports a character; its falling
 * speed lives in CharacterState, so that's zeroed too.
 */
function respawnIfFallen(world: World, w: Walker): void {
  if (world.get(w.entity, Transform).translation[1] > -12) return
  world.set(w.entity, Transform, { translation: [w.spawn[0], w.spawn[1], 0] })
  world.set(w.entity, CharacterState, { velocity: [0, 0, 0] })
}

/** An orthographic camera that follows the player, a little ahead and above. */
const follow = defineSystem({
  name: 'character2d-demo/camera',
  run: (_, world) => {
    const d = demo
    if (!d) return
    const [x, y] = world.get(d.player.entity, Transform).translation
    const want: Vec2 = [x + d.player.dir * 2, y + 2]
    const k = 1 - Math.exp(-5 * world.resource(Time).delta)
    const eye = d.eye ?? want
    eye[0] += (want[0] - eye[0]) * k
    eye[1] += (want[1] - eye[1]) * k
    d.eye = eye
    world.set(d.camera, Transform, { translation: [eye[0], eye[1], 50] })
  },
})

type Mat = (value: ConstructorParameters<typeof MaterialAsset>[0]) => AssetRef<'Material'>

/** A 2D platformer level for the character controller (physics2d, up fixed at +Y). */
export const character2dDemoPlugin = definePlugin({
  name: 'character2d-demo',
  dependencies: ['render/forward', 'physics2d'],
  build(app) {
    app.addSystems(Update, steer, follow)
    hudExtras.push((world) => {
      const d = demo
      if (!d) return []
      const s = world.get(d.player.entity, CharacterState)
      return [
        `player    ${s.grounded ? 'grounded' : `airborne ${s.airTime.toFixed(1)} s`}, ${s.velocity[0].toFixed(1)}, ${s.velocity[1].toFixed(1)} m/s`,
        `a/d: walk   shift: run   space: jump   c: colliders`,
      ]
    })
  },
  ready(app) {
    const world = app.world
    const meshes = world.resource(Meshes)
    const materials = world.resource(Materials)
    const mat: Mat = (value) => materials.add(new MaterialAsset(value))

    world.resource(AmbientLight).brightness = 1200
    world.spawn(
      [DirectionalLight, { illuminance: 50_000 }],
      [Transform, { rotation: quat.fromEuler([0, 0, 0, 1], -0.6, 0.4, 0) as never }],
    )
    const camera = world.spawn(
      [
        Camera3d,
        { projection: 'orthographic', orthoHeight: 16, clearColor: [0.05, 0.06, 0.09, 1] },
      ],
      [Exposure, { ev100: 12.5 }],
      [Transform, { translation: [0, 2, 50] }],
    )

    const level = spawnLevel(world, meshes.add(cube({ size: 1 })), mat)
    const body = meshes.add(capsule({ radius: 0.35, height: 1.8, segments: 16, rings: 6 }))
    const visorMesh = meshes.add(cube({ size: 1 }))
    const dark = mat({ baseColor: [0.08, 0.08, 0.1, 1], roughness: 0.3 })
    const spawnCharacter = (
      x: number,
      y: number,
      color: AssetRef<'Material'>,
      layers: { layers: number; mask: number },
    ): Walker => {
      const entity = world.spawn(
        [CharacterController, layers],
        [Mesh3d, { mesh: body }],
        [MeshMaterial, { material: color }],
        [Transform, { translation: [x, y, 0] }],
      )
      const visor = world.spawn(
        [Mesh3d, { mesh: visorMesh }],
        [MeshMaterial, { material: dark }],
        [Transform, { translation: [0.28, 0.5, 0.2], scale: [0.15, 0.15, 0.4] }],
        [ChildOf, { parent: entity }],
      )
      return { entity, visor, spawn: [x, y], dir: 1, next: 0, turned: 0 }
    }
    // In one lane, characters blocking each other deadlock, so the player (layer 4) and the NPCs
    // (layer 2, colliding with layer 1 only: the level and crates) pass through each other.
    const player = spawnCharacter(
      -14,
      1,
      mat({ baseColor: [0.25, 0.6, 0.95, 1], roughness: 0.4 }),
      {
        layers: 4,
        mask: 0xffff,
      },
    )
    const rng = new Rng(9)
    const npc = mat({ baseColor: [0.9, 0.6, 0.2, 1], roughness: 0.6 })
    const walkers: Walker[] = []
    // Clear of the player's start and of the gap (x 19 to 29).
    for (const x of [-6, 3, 12, 15, 33, 40])
      walkers.push(spawnCharacter(x, 4, npc, { layers: 2, mask: 1 }))

    demo = {
      player,
      camera,
      eye: undefined,
      keys: new Set(),
      walkers,
      rng,
      shuttle: level.shuttle,
      elevator: level.elevator,
      crates: level.crates,
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

/**
 * Left to right: a polyline hill, steps of 0.2 / 0.3 / 0.45 m (it climbs up to 0.3), a 30° ramp
 * it walks and a short 60° one it slides off (jump it), a gap crossed by a shuttle, a spinning bar, an elevator
 * up to a high ledge, and crates to push. Slabs are unit cubes scaled (scale scales colliders).
 */
function spawnLevel(
  world: World,
  unit: AssetRef<'Mesh'>,
  mat: Mat,
): { shuttle: Entity; elevator: Entity; crates: { entity: Entity; spawn: Vec2 }[] } {
  const rock = mat({ baseColor: [0.4, 0.42, 0.48, 1], roughness: 0.9 })
  const grass = mat({ baseColor: [0.3, 0.55, 0.35, 1], roughness: 0.9 })
  const ok = mat({ baseColor: [0.3, 0.65, 0.4, 1], roughness: 0.7 })
  const steep = mat({ baseColor: [0.8, 0.3, 0.25, 1], roughness: 0.7 })
  const metal = mat({ baseColor: [0.75, 0.78, 0.82, 1], metallic: 1, roughness: 0.35 })
  const wood = mat({ baseColor: [0.6, 0.42, 0.25, 1], roughness: 0.8 })
  const slab = (
    x: number,
    y: number,
    w: number,
    h: number,
    material: AssetRef<'Material'>,
    angle = 0,
    kind: 'fixed' | 'kinematic-position' | 'kinematic-velocity' = 'fixed',
  ) =>
    world.spawn(
      [RigidBody, { kind }],
      [Collider, { shape: 'cuboid', halfExtents: [0.5, 0.5, 0], friction: 0.7 }],
      [Mesh3d, { mesh: unit }],
      [MeshMaterial, { material }],
      [Transform, { translation: [x, y, 0], rotation: angleZ(angle), scale: [w, h, 1] }],
    )

  // The floor, with a gap from x = 19 to 29, and walls at both ends.
  slab(-2, -0.5, 42, 1, rock)
  slab(38, -0.5, 18, 1, rock)
  slab(-23.5, 6, 1, 14, rock)
  slab(47.5, 6, 1, 14, rock)

  // A hill as a polyline collider, drawn as thin slabs along its segments.
  const hill: Vec2[] = []
  for (let i = 0; i <= 16; i++) {
    const x = -20 + i * 0.5
    hill.push([x, 1.2 * Math.sin((i / 16) * Math.PI) ** 2])
  }
  world.spawn(
    [
      Collider,
      { shape: 'polyline', points: hill.map(([x, y]): [number, number, number] => [x, y, 0]) },
    ],
    [Transform, {}],
  )
  for (let i = 0; i + 1 < hill.length; i++) {
    const [ax, ay] = hill[i]!
    const [bx, by] = hill[i + 1]!
    const len = Math.hypot(bx - ax, by - ay)
    world.spawn(
      [Mesh3d, { mesh: unit }],
      [MeshMaterial, { material: grass }],
      [
        Transform,
        {
          translation: [(ax + bx) / 2, (ay + by) / 2 - 0.1, 0],
          rotation: angleZ(Math.atan2(by - ay, bx - ax)),
          scale: [len + 0.02, 0.2, 1],
        },
      ],
    )
  }
  // Steps: it walks up to stepHeight (0.3 m) and stops at the 0.45 m one.
  ;[0.2, 0.3, 0.45].forEach((h, i) => {
    slab(-8 + i * 2.5, h / 2, 1.4, h, h <= 0.3 ? ok : steep)
  })

  // Ramps: 30° walks up to a ledge; 60° is past maxSlope (45°), so it slides back.
  const ramp = (x0: number, degrees: number, length: number, material: AssetRef<'Material'>) => {
    const a = (degrees * Math.PI) / 180
    const t = 0.4
    const cx = x0 + (Math.cos(a) * length) / 2 + (Math.sin(a) * t) / 2
    const cy = (Math.sin(a) * length) / 2 - (Math.cos(a) * t) / 2
    slab(cx, cy, length, t, material, a)
    return { x: x0 + Math.cos(a) * length, y: Math.sin(a) * length }
  }
  const top = ramp(0, 30, 6, ok)
  slab(top.x + 1.5, top.y - 0.25, 3, 0.5, rock)
  // Short enough (1 m) to jump over from the ground.
  ramp(10, 60, 1.2, steep)

  // Crates (10 kg) to push toward the gap. Velocity lets a fallen crate be reset.
  const crates: { entity: Entity; spawn: Vec2 }[] = []
  for (let i = 0; i < 5; i++) {
    const spawn: Vec2 = [14 + (i % 3) * 1.05, 0.5 + Math.floor(i / 3)]
    const entity = world.spawn(
      [RigidBody, { kind: 'dynamic' }],
      [Velocity, {}],
      [Collider, { shape: 'cuboid', halfExtents: [0.5, 0.5, 0], friction: 0.5 }],
      [Mass, { mass: 10 }],
      [Mesh3d, { mesh: unit }],
      [MeshMaterial, { material: wood }],
      [Transform, { translation: [spawn[0], spawn[1], 0], scale: [0.9, 0.9, 1] }],
    )
    crates.push({ entity, spawn })
  }

  // The gap: a shuttle slides across it (steer moves it), and a bar spins by itself above.
  const shuttle = slab(24, 3, 3, 0.4, metal, 0, 'kinematic-position')
  const bar = slab(24, 8, 5, 0.3, wood, 0, 'kinematic-velocity')
  world.add(bar, Velocity, { angular: [0, 0, 0.5] })

  // An elevator up to a high ledge.
  const elevator = slab(36, 0.8, 3, 0.4, metal, 0, 'kinematic-position')
  slab(42.5, 3.5, 9, 7, rock)
  return { shuttle, elevator, crates }
}
