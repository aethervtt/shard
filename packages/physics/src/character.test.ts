import { type Entity, ProfilerResource, type World } from '@aethervtt/shard-core'
import { budget } from '@aethervtt/shard-core/test-env'
import { App } from '@aethervtt/shard-runtime'
import { Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { describe, expect, it } from 'vitest'
import { moveAndSlide } from './character'
import {
  CharacterController,
  CharacterGroundEvent,
  type CharacterGroundEventData,
  CharacterIntent,
  CharacterState,
  CharacterSuspended,
  Collider,
  GravitySource,
  Mass,
  PhysicsConfig,
  RigidBody,
} from './components'
import { Physics, physics2dPlugin, physics3dPlugin } from './plugin'

const DT = 1 / 60
/** Capsule center above the feet for the default 1.8 m character. */
const HALF = 0.9

async function app(dim: 2 | 3 = 3): Promise<App> {
  const a = new App().addPlugin(TransformPlugin, dim === 3 ? physics3dPlugin() : physics2dPlugin())
  await a.init()
  return a
}

function frames(a: App, n: number): void {
  for (let i = 0; i < n; i++) a.update(DT)
}

const pos = (world: World, e: Entity) =>
  [...world.get(e, Transform).translation] as [number, number, number]
const state = (world: World, e: Entity) => world.get(e, CharacterState)

function ground(world: World, size = 50): Entity {
  return world.spawn(
    [RigidBody, { kind: 'fixed' }],
    [Collider, { shape: 'cuboid', halfExtents: [size, 0.5, size] }],
    [Transform, { translation: [0, -0.5, 0] }],
  )
}

function character(
  world: World,
  at: [number, number, number],
  controller: Record<string, unknown> = {},
): Entity {
  return world.spawn([CharacterController, controller], [Transform, { translation: at }])
}

function walk(world: World, e: Entity, move: [number, number, number]): void {
  world.set(e, CharacterIntent, { move })
}

/** A box whose top face is at `top`, starting at z = `from` and running 10 m toward -z. */
function ledge(world: World, top: number, from: number): Entity {
  return world.spawn(
    [Collider, { shape: 'cuboid', halfExtents: [5, top / 2, 5] }],
    [Transform, { translation: [0, top / 2, from - 5] }],
  )
}

/** A 20 m ramp rising toward -z at `degrees`, its bottom edge at the origin. */
function ramp(world: World, degrees: number): Entity {
  const a = (degrees * Math.PI) / 180
  const half = 10
  return world.spawn(
    [Collider, { shape: 'cuboid', halfExtents: [5, 0.25, half], friction: 0.8 }],
    [
      Transform,
      {
        // Rotating about +X by +a tilts -z upward; the top surface passes through the origin.
        translation: [
          0,
          Math.sin(a) * half - Math.cos(a) * 0.25,
          -Math.cos(a) * half - Math.sin(a) * 0.25,
        ],
        rotation: [Math.sin(a / 2), 0, 0, Math.cos(a / 2)],
      },
    ],
  )
}

describe('character controller 3d', () => {
  it('walks at the intended speed on flat ground, grounded', async () => {
    const a = await app()
    ground(a.world)
    const c = character(a.world, [0, HALF + 0.05, 0])
    frames(a, 30)
    expect(state(a.world, c).grounded).toBe(true)
    walk(a.world, c, [0, 0, -3])
    frames(a, 30)
    const z0 = pos(a.world, c)[2]!
    frames(a, 120)
    const z1 = pos(a.world, c)[2]!
    expect((z0 - z1) / 2).toBeCloseTo(3, 1)
    expect(pos(a.world, c)[1]).toBeCloseTo(HALF, 1)
    expect(Math.abs(pos(a.world, c)[0]!)).toBeLessThan(1e-3)
    const s = state(a.world, c)
    expect(s.grounded).toBe(true)
    expect(s.velocity[2]).toBeCloseTo(-3, 2)
    expect(s.groundNormal[1]).toBeCloseTo(1, 3)
    expect(s.airTime).toBe(0)
  })

  it('climbs a 0.25 m step and stops at a 0.4 m one', async () => {
    for (const [top, climbs] of [
      [0.25, true],
      [0.4, false],
    ] as const) {
      const a = await app()
      ground(a.world)
      ledge(a.world, top, -2)
      const c = character(a.world, [0, HALF + 0.05, 0])
      frames(a, 10)
      walk(a.world, c, [0, 0, -3])
      frames(a, 120)
      const [, y, z] = pos(a.world, c)
      if (climbs) {
        expect(z).toBeLessThan(-4)
        expect(y).toBeCloseTo(HALF + top, 1)
        expect(state(a.world, c).grounded).toBe(true)
      } else {
        // Pressed against the face: the capsule's edge is at the step.
        expect(z).toBeGreaterThan(-2)
        expect(z).toBeLessThan(-2 + 0.35 + 0.05)
        expect(y).toBeCloseTo(HALF, 1)
      }
    }
  })

  it('walks up a row of steps without hopping over one taller than stepHeight (2D and 3D)', async () => {
    for (const dim of [2, 3] as const) {
      const a = await app(dim)
      ground(a.world)
      // 0.2 and 0.3 m climb; the 0.45 m one blocks. Walking up the first two used to launch the
      // character off their edges and over the third.
      for (const [x, h] of [
        [-8, 0.2],
        [-5.5, 0.3],
        [-3, 0.45],
      ] as const) {
        a.world.spawn(
          [Collider, { shape: 'cuboid', halfExtents: [0.7, h / 2, 5] }],
          [Transform, { translation: [x, h / 2, 0] }],
        )
      }
      // Facing +x: in 3D, a quarter turn around Y puts -z (forward) on +x.
      const c = character(a.world, [-12, HALF + 0.05, 0])
      if (dim === 3) a.world.set(c, Transform, { rotation: [0, -Math.SQRT1_2, 0, Math.SQRT1_2] })
      frames(a, 20)
      walk(a.world, c, dim === 2 ? [4, 0, 0] : [0, 0, -4])
      let highest = 0
      for (let i = 0; i < 240; i++) {
        a.update(DT)
        highest = Math.max(highest, pos(a.world, c)[1])
      }
      expect(highest).toBeLessThan(HALF + 0.3 + 0.05)
      expect(pos(a.world, c)[0]).toBeLessThan(-3.7)
    }
  })

  it('walks up a 40° slope and stands still on a 44° one', async () => {
    const a = await app()
    ground(a.world)
    ramp(a.world, 40)
    const c = character(a.world, [0, HALF + 0.05, 1])
    frames(a, 10)
    walk(a.world, c, [0, 0, -3])
    frames(a, 180)
    const [, y, z] = pos(a.world, c)
    // Up the ramp: height follows the slope from where it met it.
    expect(z).toBeLessThan(-4)
    expect(y - HALF).toBeGreaterThan(Math.tan((40 * Math.PI) / 180) * -z * 0.8)
    expect(state(a.world, c).grounded).toBe(true)

    const b = await app()
    ground(b.world)
    ramp(b.world, 44)
    // Dropped onto the middle of the ramp, then left alone.
    const angle = (44 * Math.PI) / 180
    const s = b.world
    const d = character(s, [0, Math.tan(angle) * 5 + HALF / Math.cos(angle) + 0.05, -5])
    frames(b, 60)
    expect(state(s, d).grounded).toBe(true)
    const rest = pos(s, d)
    frames(b, 180)
    const after = pos(s, d)
    expect(
      Math.hypot(after[0]! - rest[0]!, after[1]! - rest[1]!, after[2]! - rest[2]!),
    ).toBeLessThan(0.02)
  })

  it('jumps to jumpSpeed² / 2g and sends ground events on takeoff and landing', async () => {
    const a = await app()
    ground(a.world)
    const c = character(a.world, [0, HALF + 0.05, 0])
    frames(a, 30)
    const reader = a.world.reader(CharacterGroundEvent)
    reader.read()
    const standing = pos(a.world, c)[1]!
    a.world.set(c, CharacterIntent, { jump: true })
    const seen: CharacterGroundEventData[] = []
    let peak = standing
    for (let i = 0; i < 120; i++) {
      a.update(DT)
      peak = Math.max(peak, pos(a.world, c)[1]!)
      seen.push(...reader.read())
    }
    const expected = 5 ** 2 / (2 * 9.81)
    expect(Math.abs(peak - standing - expected) / expected).toBeLessThan(0.05)
    expect(seen).toEqual([
      { entity: c, grounded: false },
      { entity: c, grounded: true },
    ])
    // The jump was consumed: it doesn't bounce again.
    expect(a.world.get(c, CharacterIntent).jump).toBe(false)
    expect(state(a.world, c).grounded).toBe(true)
    expect(pos(a.world, c)[1]).toBeCloseTo(standing, 2)
  })

  it('walks around a planet with a GravitySource and comes back to the start', async () => {
    const a = await app()
    const w = a.world
    w.resource(PhysicsConfig).gravity = [0, 0, 0]
    const R = 8
    w.spawn(
      [Collider, { shape: 'ball', radius: R }],
      [GravitySource, { strength: 9.81, radius: R }],
      [Transform, {}],
    )
    const start: [number, number, number] = [0, R + HALF + 0.05, 0]
    const c = character(w, start, { up: 'gravity' })
    frames(a, 30)
    expect(state(w, c).grounded).toBe(true)
    walk(w, c, [0, 0, -3])
    // The capsule's center circles at R + HALF, moving 3 m/s.
    const lap = (2 * Math.PI * (R + HALF)) / 3
    const steps = Math.round(lap / DT)
    let alwaysGrounded = true
    let worstUp = 1
    for (let i = 0; i < steps; i++) {
      a.update(DT)
      const s = state(w, c)
      if (!s.grounded) alwaysGrounded = false
      // The entity's +Y points away from the center.
      const [x, y, z] = pos(w, c)
      const len = Math.hypot(x!, y!, z!)
      const [qx, qy, qz, qw] = w.get(c, Transform).rotation
      const upX = 2 * (qx * qy - qw * qz)
      const upY = 1 - 2 * (qx * qx + qz * qz)
      const upZ = 2 * (qy * qz + qw * qx)
      worstUp = Math.min(worstUp, (upX * x! + upY * y! + upZ * z!) / len)
    }
    const end = pos(w, c)
    expect(alwaysGrounded).toBe(true)
    expect(worstUp).toBeGreaterThan(0.999)
    // It went all the way around: past the far side and back.
    expect(Math.hypot(end[0]! - start[0], end[1]! - start[1], end[2]! - start[2])).toBeLessThan(1)
  })

  it('rides a moving kinematic platform', async () => {
    const a = await app()
    const w = a.world
    ground(w)
    const platform = w.spawn(
      [RigidBody, { kind: 'kinematic-position' }],
      [Collider, { shape: 'cuboid', halfExtents: [2, 0.25, 2] }],
      [Transform, { translation: [0, 1, 0] }],
    )
    const c = character(w, [0, 1.25 + HALF + 0.05, 0])
    frames(a, 30)
    expect(state(w, c).groundEntity).toBe(platform)
    const x0 = pos(w, c)[0]!
    // The platform slides 3 m along +x over 3 s.
    for (let i = 1; i <= 180; i++) {
      w.set(platform, Transform, { translation: [(i / 180) * 3, 1, 0] })
      a.update(DT)
    }
    frames(a, 5)
    expect(pos(w, c)[0]! - x0).toBeCloseTo(3, 1)
    expect(state(w, c).grounded).toBe(true)
    expect(state(w, c).groundEntity).toBe(platform)
  })

  it('keeps its place on a kinematic platform that speeds up to 5 m/s while bobbing', async () => {
    const a = await app()
    const w = a.world
    // A raft 1 m up, sailing along +x: 1.2 m/s² up to 5 m/s, bobbing ±0.5 m every 4 s.
    const raft = w.spawn(
      [RigidBody, { kind: 'kinematic-position' }],
      [Collider, { shape: 'cuboid', halfExtents: [20, 0.25, 4] }],
      [Transform, { translation: [0, 1, 0] }],
    )
    // Two castaways, one just behind the other: each is carried without bumping the other's capsule.
    const c = character(w, [1, 1.25 + HALF + 0.05, 0.5])
    const behind = character(w, [0.28, 1.25 + HALF + 0.05, 0.5])
    frames(a, 30)
    expect(state(w, c).groundEntity).toBe(raft)
    expect(state(w, behind).groundEntity).toBe(raft)
    const [x0, y0, z0] = pos(w, c)
    const [bx0, by0, bz0] = pos(w, behind)
    expect(x0 - bx0).toBeLessThan(0.75)
    let x = 0
    let v = 0
    let worst = 0
    for (let i = 1; i <= 600; i++) {
      const acc = v < 5 ? 1.2 : 0
      x += v * DT + 0.5 * acc * DT * DT
      v = Math.min(5, v + acc * DT)
      const y = 1 + 0.5 * Math.sin((i * DT * 2 * Math.PI) / 4)
      w.set(raft, Transform, { translation: [x, y, 0] })
      a.update(DT)
      const [cx, cy, cz] = pos(w, c)
      const [bx, by, bz] = pos(w, behind)
      worst = Math.max(
        worst,
        Math.hypot(cx - x - x0, cy - (y - 1) - y0, cz - z0),
        Math.hypot(bx - x - bx0, by - (y - 1) - by0, bz - bz0),
      )
    }
    expect(v).toBe(5)
    expect(worst).toBeLessThan(0.02)
    expect(state(w, c).groundEntity).toBe(raft)
  })

  it('pushes a 10 kg box it walks into', async () => {
    const a = await app()
    const w = a.world
    ground(w)
    const box = w.spawn(
      [RigidBody, { kind: 'dynamic' }],
      [Collider, { shape: 'cuboid', halfExtents: [0.5, 0.5, 0.5] }],
      [Mass, { mass: 10 }],
      [Transform, { translation: [0, 0.5, -2] }],
    )
    const c = character(w, [0, HALF + 0.05, 0])
    frames(a, 30)
    walk(w, c, [0, 0, -2])
    frames(a, 180)
    const bz = pos(w, box)[2]!
    // Walking for 3 s at 2 m/s: the box moved a good way and stays ahead of the character.
    expect(bz).toBeLessThan(-5)
    expect(bz).toBeLessThan(pos(w, c)[2]!)
    expect(w.resource(Physics).bodies.get(box)!.body.mass()).toBeCloseTo(10, 3)
  })

  it('teleports when a game writes its Transform, and cleans up when removed', async () => {
    const a = await app()
    const w = a.world
    ground(w)
    const c = character(w, [0, HALF + 0.05, 0])
    frames(a, 10)
    w.set(c, Transform, { translation: [10, HALF + 0.05, 10] })
    frames(a, 10)
    const [x, y, z] = pos(w, c)
    expect(x).toBeCloseTo(10, 3)
    expect(z).toBeCloseTo(10, 3)
    expect(y).toBeCloseTo(HALF, 1)
    const p = w.resource(Physics)
    expect(p.describe().characters).toBe(1)
    w.remove(c, CharacterController)
    frames(a, 1)
    expect(p.describe().characters).toBe(0)
    expect(p.colliders.has(c)).toBe(false)
  })

  it('suspended, follows its Transform without falling or walking; resumes where it is', async () => {
    const a = await app()
    const w = a.world
    ground(w)
    const c = character(w, [0, 3, 0])
    w.add(c, CharacterSuspended)
    walk(w, c, [4, 0, 0])
    frames(a, 30)
    // No gravity, no walking: it stays where its Transform says.
    expect(pos(w, c)).toEqual([0, 3, 0])
    // Moved by its Transform (a cheap mover), the capsule goes with it: a ray finds it there.
    w.set(c, Transform, { translation: [5, 3, 5] })
    frames(a, 2)
    const p = w.resource(Physics)
    const hit = {
      entity: -1,
      body: -1,
      distance: 0,
      point: new Float32Array(3),
      normal: new Float32Array(3),
    }
    expect(p.raycast([5, 6, 5], [0, -1, 0], { maxDistance: 10 }, hit as never)).toBe(true)
    expect(hit.entity).toBe(c)
    // Back to the controller: it falls to the ground and walks.
    w.remove(c, CharacterSuspended)
    frames(a, 90)
    const [x, y] = pos(w, c)
    expect(y).toBeCloseTo(HALF, 1)
    expect(x).toBeGreaterThan(5)
  })

  it('moveAndSlide: a suspended capsule stops at a box and slides along it, fixed or kinematic', async () => {
    for (const kind of ['fixed', 'kinematic-position'] as const) {
      const a = await app()
      const w = a.world
      // A wall 2 m thick along z, its -x face at x = -1.
      const box = w.spawn(
        [RigidBody, { kind }],
        [Collider, { shape: 'cuboid', halfExtents: [1, 2, 10] }],
        [Transform, { translation: [0, 3, 0] }],
      )
      // Facing 30° off the wall: the swept capsule's normals come back in its own frame.
      const turn = Math.PI / 12
      const c = w.spawn(
        [CharacterController, {}],
        [CharacterSuspended, {}],
        [Transform, { translation: [-3, 3, 0], rotation: [0, Math.sin(turn), 0, Math.cos(turn)] }],
      )
      frames(a, 2)
      // Toward the wall and along it, 0.2 m and 0.1 m a step.
      let touched = false
      for (let i = 0; i < 30; i++) {
        const r = moveAndSlide(w, c, [0.2, 0, 0.1])
        for (const h of r.hits) {
          if (h.entity !== box) continue
          touched = true
          expect(h.body).toBe(box)
          expect(h.normal[0]).toBeCloseTo(-1, 3)
        }
        expect([...r.position]).toEqual(pos(w, c))
        a.update(DT)
      }
      expect(touched).toBe(true)
      const [x, y, z] = pos(w, c)
      // Against the face (radius 0.35 and Rapier's 1 cm gap), the whole slide along it.
      expect(x).toBeCloseTo(-1.36, 3)
      expect(y).toBeCloseTo(3, 3)
      expect(z).toBeCloseTo(3, 3)
      // The capsule is there too: a ray down from above the character finds it.
      const hit = {
        entity: -1,
        body: -1,
        distance: 0,
        point: new Float32Array(3),
        normal: new Float32Array(3),
      }
      expect(w.resource(Physics).raycast([x, 6, z], [0, -1, 0], {}, hit as never)).toBe(true)
      expect(hit.entity).toBe(c)
    }
  })

  it('moveAndSlide: through open space, it ends exactly at position + delta', async () => {
    const a = await app()
    const w = a.world
    ground(w)
    const c = character(w, [2, 5, -1])
    w.add(c, CharacterSuspended)
    frames(a, 2)
    const r = moveAndSlide(w, c, [1.5, -0.75, 2.25])
    expect(r.hits).toEqual([])
    expect([...r.position]).toEqual([3.5, 4.25, 1.25])
    expect(pos(w, c)).toEqual([3.5, 4.25, 1.25])
    frames(a, 5)
    // Suspended: no gravity, nothing else moves it.
    expect(pos(w, c)).toEqual([3.5, 4.25, 1.25])
  })

  it('steps 100 controllers within 1.5 ms', async () => {
    const a = await app()
    const w = a.world
    ground(w, 100)
    const chars: Entity[] = []
    for (let i = 0; i < 100; i++) {
      const x = (i % 10) * 3 - 15
      const z = Math.floor(i / 10) * 3 - 15
      const e = character(w, [x, HALF + 0.05, z])
      walk(w, e, [Math.sin(i), 0, -2])
      chars.push(e)
    }
    frames(a, 60) // warm up: everyone lands and starts walking
    const profiler = w.resource(ProfilerResource)
    frames(a, 120)
    // The controllers' own system, and the physics step their 100 kinematic bodies go through.
    const controller = profiler.timing('physics/character')!.avg
    const ms = controller + profiler.timing('physics/step')!.avg
    expect(ms).toBeLessThan(budget('physics/characters'))
    expect(chars.every((e) => state(w, e).grounded)).toBe(true)
  })
})

describe('character controller 2d', () => {
  it('walks, jumps between platforms, and stands on a polyline', async () => {
    const a = await app(2)
    const w = a.world
    // A polyline floor with a bump, then a gap to a floating platform.
    w.spawn(
      [
        Collider,
        {
          shape: 'polyline',
          points: [
            [-10, 0, 0],
            [0, 0, 0],
            [2, 0.2, 0],
            [4, 0, 0],
            [6, 0, 0],
          ],
        },
      ],
      [Transform, {}],
    )
    w.spawn(
      [Collider, { shape: 'cuboid', halfExtents: [2, 0.25, 0] }],
      [Transform, { translation: [10, 0.75, 0] }],
    )
    const c = character(w, [-5, HALF + 0.05, 0])
    frames(a, 30)
    expect(state(w, c).grounded).toBe(true)
    expect(pos(w, c)[1]).toBeCloseTo(HALF, 1)
    // 2D: move.x walks right.
    walk(w, c, [3, 0, 0])
    let jumped = false
    for (let i = 0; i < 300; i++) {
      const [x] = pos(w, c)
      if (!jumped && x! > 5) {
        w.set(c, CharacterIntent, { move: [3, 0, 0], jump: true })
        jumped = true
      }
      if (x! > 10) walk(w, c, [0, 0, 0])
      a.update(DT)
    }
    const [x, y, z] = pos(w, c)
    expect(x).toBeGreaterThan(9)
    expect(x).toBeLessThan(12)
    expect(y).toBeCloseTo(1 + HALF, 1)
    expect(z).toBe(0)
    expect(state(w, c).grounded).toBe(true)
  })
})
