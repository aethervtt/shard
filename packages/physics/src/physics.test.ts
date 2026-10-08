import { type Entity, ProfilerResource, Rng, type World } from '@aethervtt/shard-core'
import { budget, timeout } from '@aethervtt/shard-core/test-env'
import { Mesh, plane, sphere } from '@aethervtt/shard-mesh'
import { Meshes } from '@aethervtt/shard-render'
import { App, animationFrameRunner, FixedTime, FrameDemand, Time } from '@aethervtt/shard-runtime'
import { fakeAnimationFrames } from '@aethervtt/shard-runtime/testing'
import { Transform, TransformPlugin, transform2d, worldPosition } from '@aethervtt/shard-transform'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  Collider,
  CollisionEvent,
  type CollisionEventData,
  ExternalForce,
  ExternalImpulse,
  GravitySource,
  Joint,
  Mass,
  PhysicsConfig,
  RigidBody,
  Velocity,
} from './components'
import { Physics, physics2dPlugin, physics3dPlugin } from './plugin'
import { createRayHit } from './world'

const DT = 1 / 60

// Every suite runs on both Rapier builds (0053): the deterministic one must behave the same.
const VARIANTS = ['regular', 'deterministic'] as const
let variant: (typeof VARIANTS)[number] = 'regular'
const useVariant = (v: typeof variant) =>
  beforeEach(() => {
    variant = v
  })

async function app(dim: 2 | 3 = 3, setup?: (app: App) => void): Promise<App> {
  const options = { deterministic: variant === 'deterministic' }
  const a = new App().addPlugin(
    TransformPlugin,
    dim === 3 ? physics3dPlugin(options) : physics2dPlugin(options),
  )
  await a.init()
  setup?.(a)
  return a
}

function frames(a: App, n: number, delta = DT): void {
  for (let i = 0; i < n; i++) a.update(delta)
}

function pos(world: World, e: Entity): number[] {
  return [...world.get(e, Transform).translation]
}

function ground(world: World): Entity {
  return world.spawn(
    [RigidBody, { kind: 'fixed' }],
    [Collider, { shape: 'cuboid', halfExtents: [50, 0.5, 50] }],
    [Transform, { translation: [0, -0.5, 0] }],
  )
}

function ball(world: World, at: [number, number, number], extra: Record<string, unknown> = {}) {
  return world.spawn(
    [RigidBody, { kind: 'dynamic' }],
    [Collider, { shape: 'ball', radius: 0.5, ...extra }],
    [Velocity, {}],
    [Transform, { translation: at }],
  )
}

/** The first physics step after which a falling ball (radius 0.5) reaches the ground at y = 0. */
function landingStep(a: App, e: Entity, max = 200): number {
  for (let i = 1; i <= max; i++) {
    a.update(DT)
    if (pos(a.world, e)[1]! <= 0.5 + 1e-3) return a.world.resource(Physics).steps
  }
  return -1
}

describe.each(VARIANTS)('physics 3d (%s)', (v) => {
  useVariant(v)

  it('runs on the requested Rapier build, and physics.describe says which', async () => {
    const a = await app()
    const p = a.world.resource(Physics)
    expect(p.variant).toBe(v)
    expect(p.R.version()).toBe('0.20.0')
    const method = a.methods.find((m) => m.name === 'physics.describe')!
    expect(method.handler({ app: a, world: a.world }, {})).toMatchObject({ variant: v })
  })

  it('lands a dropped body when free fall predicts, within one step', async () => {
    const a = await app()
    ground(a.world)
    const b = ball(a.world, [0, 10.5, 0])
    // Free fall of 10 m takes sqrt(2h / g) seconds.
    const n = Math.sqrt((2 * 10) / 9.81) / DT
    const step = landingStep(a, b)
    expect(Math.abs(step - n)).toBeLessThanOrEqual(1)
    frames(a, 60)
    expect(pos(a.world, b)[1]).toBeCloseTo(0.5, 1)
    expect(worldPosition(a.world, b)[1]).toBeCloseTo(0.5, 1) // propagation saw the writes
  })

  it('settles a pile of 1,000 dropped boxes until they all sleep', {
    timeout: timeout(120_000),
  }, async () => {
    const a = await app()
    ground(a.world)
    const rng = new Rng(3)
    const boxes: Entity[] = []
    for (let i = 0; i < 1000; i++) {
      // Jittered columns, tilted, dropped from up to 25 m: they tumble into a pile.
      const x = (i % 10) * 1.3 - 6 + rng.range(-0.2, 0.2)
      const z = (Math.floor(i / 10) % 10) * 1.3 - 6 + rng.range(-0.2, 0.2)
      const y = 2 + Math.floor(i / 100) * 2.5
      const angle = rng.range(0, Math.PI)
      boxes.push(
        a.world.spawn(
          [RigidBody, { kind: 'dynamic' }],
          [Collider, { shape: 'cuboid', halfExtents: [0.5, 0.5, 0.5] }],
          [
            Transform,
            {
              translation: [x, y, z],
              rotation: [
                Math.sin(angle / 2) * 0.6,
                0,
                Math.sin(angle / 2) * 0.8,
                Math.cos(angle / 2),
              ],
            },
          ],
        ),
      )
    }
    let asleep = 0
    let seconds = 0
    for (; seconds < 30 && asleep < boxes.length; seconds++) {
      frames(a, 60)
      asleep = a.world.resource(Physics).describe().sleeping
    }
    expect(asleep).toBe(boxes.length)
    expect(seconds).toBeGreaterThan(2) // it really fell and tumbled
  })

  it('runs physics for 5,000 awake bodies in under 8 ms per step (bench)', {
    timeout: timeout(60_000),
  }, async () => {
    const a = await app()
    ground(a.world)
    for (let i = 0; i < 5000; i++) {
      const x = (i % 50) * 1.5 - 37
      const z = (Math.floor(i / 50) % 50) * 1.5 - 37
      const b = ball(a.world, [x, 1 + Math.floor(i / 2500) * 1.5 + (i % 7) * 0.01, z])
      a.world.set(b, RigidBody, { canSleep: false })
    }
    frames(a, 60) // warm up: bodies fall, land, and keep resting contacts awake
    const profiler = a.world.resource(ProfilerResource)
    frames(a, 120)
    let ms = 0
    for (const name of ['physics/sync-in', 'physics/step', 'physics/sync-out']) {
      ms += profiler.timing(name)!.avg
    }
    expect(ms).toBeLessThan(budget('physics/bodies-5k'))
  })

  it('replays exactly: two runs of the same scene give the same poses', {
    timeout: timeout(60_000),
  }, async () => {
    const run = async () => {
      const a = await app()
      ground(a.world)
      const rng = new Rng(7)
      const list: Entity[] = []
      for (let i = 0; i < 100; i++) {
        list.push(
          ball(a.world, [rng.range(-3, 3), rng.range(1, 10), rng.range(-3, 3)], {
            radius: rng.range(0.2, 0.6),
          }),
        )
      }
      frames(a, 600)
      return list.flatMap((e) => [...pos(a.world, e), ...a.world.get(e, Transform).rotation])
    }
    const first = await run()
    const second = await run()
    expect(second).toEqual(first)
  })

  it('builds trimesh, convex, and heightfield colliders', async () => {
    const a = await app()
    const meshes = a.world.initResource(Meshes)
    const floor = meshes.add(plane({ size: 20 }))
    a.world.spawn([Collider, { shape: 'trimesh', mesh: floor }], [Transform, {}])
    const onMesh = ball(a.world, [0, 3, 0])
    // A convex hull of a sphere on a 20° slope rolls down it.
    const slope = a.world.spawn(
      [Collider, { shape: 'cuboid', halfExtents: [10, 0.5, 4] }],
      [Transform, { translation: [30, 0, 0], rotation: [0, 0, Math.sin(-0.17), Math.cos(-0.17)] }],
    )
    const hull = a.world.spawn(
      [RigidBody, { kind: 'dynamic' }],
      [Collider, { shape: 'convex', mesh: meshes.add(sphere({ radius: 0.5, segments: 12 })) }],
      [Transform, { translation: [30, 1.2, 0] }],
    )
    // A flat heightfield of 5 × 5 samples at height 1.
    a.world.spawn(
      [
        Collider,
        {
          shape: 'heightfield',
          halfExtents: [5, 1, 5],
          heightfield: { rows: 5, cols: 5, heights: new Array(25).fill(1) },
        },
      ],
      [Transform, { translation: [-30, 0, 0] }],
    )
    const onField = ball(a.world, [-30, 4, 0])
    frames(a, 180)
    expect(pos(a.world, onMesh)[1]).toBeCloseTo(0.5, 1)
    expect(pos(a.world, onField)[1]).toBeCloseTo(1.5, 1)
    const [hx, hy] = pos(a.world, hull)
    expect(hx).toBeGreaterThan(31) // rolled down the slope, to +x
    expect(hy).toBeGreaterThan(-3) // and stayed on it
    expect(a.world.has(slope, Collider)).toBe(true)
  })

  it('reports a sensor pass-through once as started and once as stopped', async () => {
    const a = await app()
    a.world.spawn(
      [Collider, { shape: 'cuboid', halfExtents: [2, 0.5, 2], sensor: true, events: true }],
      [Transform, { translation: [0, 5, 0] }],
    )
    const b = ball(a.world, [0, 8, 0])
    const reader = a.world.reader(CollisionEvent)
    const seen: CollisionEventData[] = []
    for (let i = 0; i < 90; i++) {
      a.update(DT)
      seen.push(...reader.read())
    }
    expect(seen.map((e) => e.kind)).toEqual(['started', 'stopped'])
    expect(seen.every((e) => e.sensor)).toBe(true)
    expect([seen[0]!.bodyA, seen[0]!.bodyB]).toContain(b)
  })

  it('attaches colliders on child entities to the ancestor body', async () => {
    const a = await app()
    ground(a.world)
    const body = a.world.spawn(
      [RigidBody, { kind: 'dynamic' }],
      [Transform, { translation: [0, 3, 0] }],
    )
    const left = a.world.spawn(
      [Collider, { shape: 'cuboid', halfExtents: [0.5, 0.5, 0.5] }],
      [Transform, { translation: [-1, 0, 0] }],
    )
    const right = a.world.spawn(
      [Collider, { shape: 'ball', radius: 0.5 }],
      [Transform, { translation: [1, 0, 0] }],
    )
    const { ChildOf } = await import('@aethervtt/shard-core')
    a.world.add(left, ChildOf, { parent: body })
    a.world.add(right, ChildOf, { parent: body })
    frames(a, 120)
    const p = a.world.resource(Physics)
    expect(p.colliderOwner.get(left)).toBe(body)
    expect(p.colliderOwner.get(right)).toBe(body)
    expect(pos(a.world, body)[1]).toBeCloseTo(0.5, 1)
    expect(pos(a.world, left)).toEqual([-1, 0, 0]) // children keep their local offsets
  })

  it('pulls bodies toward a GravitySource from every side', async () => {
    const a = await app(3, (x) => {
      x.world.resource(PhysicsConfig).gravity = [0, 0, 0]
    })
    a.world.spawn(
      [Collider, { shape: 'ball', radius: 5 }],
      [GravitySource, { strength: 9.81, radius: 5 }],
      [Transform, {}],
    )
    const starts: [number, number, number][] = [
      [0, 10, 0],
      [10, 0, 0],
      [0, 0, -10],
      [-7, -7, 0],
      [0, -9, 3],
    ]
    const bodies = starts.map((s) => ball(a.world, s))
    frames(a, 240)
    for (const b of bodies) {
      const [x, y, z] = pos(a.world, b)
      expect(Math.sqrt(x! * x! + y! * y! + z! * z!)).toBeCloseTo(5.5, 1)
    }
  })

  it('raycasts to the nearest collider, respecting masks', async () => {
    const a = await app()
    ground(a.world)
    const high = a.world.spawn(
      [Collider, { shape: 'cuboid', halfExtents: [1, 0.1, 1], layers: 2 }],
      [Transform, { translation: [0, 5, 0] }],
    )
    frames(a, 1)
    const p = a.world.resource(Physics)
    const hit = createRayHit()
    expect(p.raycast([0, 10, 0], [0, -2, 0], undefined, hit)).toBe(true)
    expect(hit.entity).toBe(high)
    expect(hit.distance).toBeCloseTo(4.9, 4)
    expect([...hit.normal]).toEqual([0, 1, 0])
    expect(p.raycast([0, 10, 0], [0, -1, 0], { mask: 1 }, hit)).toBe(true)
    expect(hit.entity).not.toBe(high)
    expect(hit.point[1]).toBeCloseTo(0, 4)
    expect(p.raycast([0, 10, 0], [0, 1, 0], undefined, hit)).toBe(false)
    expect(p.raycastAll([0, 10, 0], [0, -1, 0]).map((h) => h.entity)[0]).toBe(high)
    let overlapped = 0
    p.overlapPoint([0, 5, 0], undefined, () => {
      overlapped++
      return true
    })
    expect(overlapped).toBe(1)
  })

  it('rebuilds a collider when its fields change', async () => {
    const a = await app()
    const b = ball(a.world, [0, 0, 0])
    a.world.set(b, RigidBody, { kind: 'fixed' })
    frames(a, 1)
    a.world.set(b, Collider, { radius: 2 })
    frames(a, 1)
    expect(a.world.resource(Physics).colliders.get(b)!.radius()).toBeCloseTo(2)
  })

  it('applies forces, impulses, velocities, mass, and teleports', async () => {
    const a = await app(3, (x) => {
      x.world.resource(PhysicsConfig).gravity = [0, 0, 0]
    })
    const pushed = ball(a.world, [0, 0, 0])
    a.world.add(pushed, Mass, { mass: 2 })
    a.world.add(pushed, ExternalForce, { force: [4, 0, 0] }) // 2 m/s² on 2 kg
    const kicked = ball(a.world, [10, 0, 0])
    a.world.add(kicked, Mass, { mass: 1 })
    a.world.add(kicked, ExternalImpulse, { impulse: [0, 3, 0] })
    frames(a, 60)
    expect(a.world.resource(Physics).bodies.get(pushed)!.body.mass()).toBeCloseTo(2, 4)
    expect(a.world.get(pushed, Velocity).linear[0]).toBeCloseTo(2, 1)
    expect(a.world.get(kicked, Velocity).linear[1]).toBeCloseTo(3, 3)
    expect([...a.world.get(kicked, ExternalImpulse).impulse]).toEqual([0, 0, 0])
    a.world.set(kicked, Velocity, { linear: [0, 0, -1] })
    a.world.set(kicked, Transform, { translation: [100, 0, 0] })
    frames(a, 60)
    const [x, y, z] = pos(a.world, kicked)
    expect(x).toBeCloseTo(100, 3)
    expect(y).toBeCloseTo(0, 3)
    expect(z).toBeCloseTo(-1, 1)
  })

  it('keeps a revolute pendulum at its length', async () => {
    const a = await app()
    const pivot = a.world.spawn(
      [RigidBody, { kind: 'fixed' }],
      [Transform, { translation: [0, 5, 0] }],
    )
    const bob = ball(a.world, [2, 5, 0], { radius: 0.2 })
    a.world.add(bob, Joint, {
      kind: 'revolute',
      other: pivot,
      anchor: [-2, 0, 0],
      axis: [0, 0, 1],
    })
    let lowest = 5
    for (let i = 0; i < 120; i++) {
      a.update(DT)
      const [x, y] = pos(a.world, bob)
      expect(Math.hypot(x!, y! - 5)).toBeCloseTo(2, 1)
      lowest = Math.min(lowest, y!)
    }
    expect(lowest).toBeLessThan(3.1) // it swung through the bottom
  })

  it('interpolates transforms between steps on fast displays', async () => {
    const run = async (interpolate: boolean) => {
      const a = await app(3, (x) => {
        x.world.resource(PhysicsConfig).interpolate = interpolate
      })
      const b = ball(a.world, [0, 100, 0])
      frames(a, 30, 1 / 144)
      const ys: number[] = []
      for (let i = 0; i < 30; i++) {
        a.update(1 / 144)
        ys.push(pos(a.world, b)[1]!)
      }
      return ys
    }
    const repeats = (ys: number[]) => ys.filter((y, i) => i > 0 && y === ys[i - 1]).length
    expect(repeats(await run(false))).toBeGreaterThan(10) // 144 Hz frames, 60 Hz steps
    const smooth = await run(true)
    expect(repeats(smooth)).toBe(0)
    for (let i = 1; i < smooth.length; i++) expect(smooth[i]!).toBeLessThan(smooth[i - 1]!)
  })

  it('removes bodies and colliders when their entities despawn', async () => {
    const a = await app()
    const b = ball(a.world, [0, 0, 0])
    frames(a, 1)
    a.world.despawn(b)
    frames(a, 1)
    const p = a.world.resource(Physics)
    expect(p.bodies.size).toBe(0)
    expect(p.colliders.size).toBe(0)
    expect(p.raw.bodies.len()).toBe(0)
    expect(p.raw.colliders.len()).toBe(0)
  })

  it('refuses both dimensions in one app', async () => {
    const a = new App().addPlugin(TransformPlugin, physics3dPlugin(), physics2dPlugin())
    await expect(a.init()).rejects.toMatchObject({ code: 'physics/both-dimensions' })
  })
})

describe.each(VARIANTS)('physics 2d (%s)', (v) => {
  useVariant(v)

  it('drops a body under free fall onto a polyline and keeps z', async () => {
    const a = await app(2)
    a.world.spawn(
      [
        Collider,
        {
          shape: 'polyline',
          points: [
            [-20, 0, 0],
            [20, 0, 0],
          ],
        },
      ],
      [Transform, {}],
    )
    const b = a.world.spawn(
      [RigidBody, { kind: 'dynamic' }],
      [Collider, { shape: 'ball', radius: 0.5 }],
      [Velocity, {}],
      [Transform, transform2d({ x: 0, y: 10.5, z: 3 })],
    )
    const n = Math.sqrt((2 * 10) / 9.81) / DT
    expect(Math.abs(landingStep(a, b) - n)).toBeLessThanOrEqual(1)
    frames(a, 60)
    const [, y, z] = pos(a.world, b)
    expect(y).toBeCloseTo(0.5, 1)
    expect(z).toBe(3)
  })

  it('rolls a box on its Z rotation and rejects 3D-only shapes', async () => {
    const a = await app(2)
    ground(a.world)
    const box = a.world.spawn(
      [RigidBody, { kind: 'dynamic' }],
      [Collider, { shape: 'cuboid', halfExtents: [0.5, 0.5, 0] }],
      [Velocity, { angular: [0, 0, 3] }],
      [Transform, transform2d({ y: 3 })],
    )
    const cyl = a.world.spawn([Collider, { shape: 'cylinder' }], [Transform, {}])
    frames(a, 30)
    const r = a.world.get(box, Transform).rotation
    expect(r[0]).toBe(0)
    expect(r[1]).toBe(0)
    expect(Math.abs(r[2])).toBeGreaterThan(0.1)
    expect(a.world.resource(Physics).colliders.has(cyl)).toBe(false)
    expect(a.world.resource(FixedTime).elapsed).toBeGreaterThan(0)
  })

  it('reports a sensor pass-through once as started and once as stopped', async () => {
    const a = await app(2)
    a.world.spawn(
      [Collider, { shape: 'cuboid', halfExtents: [2, 0.5, 0], sensor: true, events: true }],
      [Transform, { translation: [0, 5, 0] }],
    )
    const b = ball(a.world, [0, 8, 0])
    const reader = a.world.reader(CollisionEvent)
    const seen: CollisionEventData[] = []
    for (let i = 0; i < 90; i++) {
      a.update(DT)
      seen.push(...reader.read())
    }
    expect(seen.map((e) => e.kind)).toEqual(['started', 'stopped'])
    expect(seen.every((e) => e.sensor)).toBe(true)
    expect([seen[0]!.bodyA, seen[0]!.bodyB]).toContain(b)
  })

  it('builds convex, heightfield, segment, and trimesh colliders', async () => {
    const a = await app(2)
    // A flat heightfield of 5 samples at height 1, spanning x in [-5, 5].
    a.world.spawn(
      [
        Collider,
        {
          shape: 'heightfield',
          halfExtents: [5, 1, 0],
          heightfield: { rows: 1, cols: 5, heights: [1, 1, 1, 1, 1] },
        },
      ],
      [Transform, {}],
    )
    const onField = ball(a.world, [0, 4, 0])
    a.world.spawn(
      [
        Collider,
        {
          shape: 'segment',
          points: [
            [15, 0, 0],
            [25, 0, 0],
          ],
        },
      ],
      [Transform, {}],
    )
    // A convex hexagon dropped on the segment.
    const hex = a.world.spawn(
      [RigidBody, { kind: 'dynamic' }],
      [
        Collider,
        {
          shape: 'convex',
          points: Array.from({ length: 6 }, (_, i): [number, number, number] => [
            Math.cos((i / 6) * Math.PI * 2) * 0.5,
            Math.sin((i / 6) * Math.PI * 2) * 0.5,
            0,
          ]),
        },
      ],
      [Transform, { translation: [20, 3, 0] }],
    )
    // A trimesh floor from a mesh's positions (x and y).
    const meshes = a.world.initResource(Meshes)
    const floor = Mesh.create({
      positions: new Float32Array([-45, 0, 0, -35, 0, 0, -40, -1, 0]),
      indices: new Uint32Array([0, 2, 1]),
    })
    a.world.spawn([Collider, { shape: 'trimesh', mesh: meshes.add(floor) }], [Transform, {}])
    const onMesh = ball(a.world, [-40, 3, 0])
    frames(a, 180)
    expect(pos(a.world, onField)[1]).toBeCloseTo(1.5, 1)
    expect(pos(a.world, onMesh)[1]).toBeCloseTo(0.5, 1)
    expect(pos(a.world, hex)[1]).toBeCloseTo(0.43, 1) // on a flat side: a radius-0.5 hexagon is 0.43 tall to its flat
    expect(pos(a.world, hex)[0]).toBeGreaterThan(15)
  })

  it('raycasts and overlaps in the plane, respecting masks', async () => {
    const a = await app(2)
    ground(a.world)
    const high = a.world.spawn(
      [Collider, { shape: 'cuboid', halfExtents: [1, 0.1, 0], layers: 2 }],
      [Transform, { translation: [0, 5, 0] }],
    )
    frames(a, 1)
    const p = a.world.resource(Physics)
    const hit = createRayHit()
    expect(p.raycast([0, 10], [0, -2], undefined, hit)).toBe(true)
    expect(hit.entity).toBe(high)
    expect(hit.distance).toBeCloseTo(4.9, 4)
    expect([...hit.normal]).toEqual([0, 1, 0])
    expect(p.raycast([0, 10], [0, -1], { mask: 1 }, hit)).toBe(true)
    expect(hit.point[1]).toBeCloseTo(0, 4)
    expect(p.raycastAll([0, 10], [0, -1]).map((h) => h.entity)[0]).toBe(high)
    const found: Entity[] = []
    p.overlapPoint([0.5, 5], undefined, (e) => {
      found.push(e)
      return true
    })
    expect(found).toEqual([high])
    found.length = 0
    p.overlapShape({ shape: 'ball', radius: 0.3 }, [0, 5.3], [0, 0, 0, 1], undefined, (e) => {
      found.push(e)
      return true
    })
    expect(found).toEqual([high])
    expect(
      p.shapeCast({ shape: 'ball', radius: 0.5 }, [0, 10], [0, 0, 0, 1], [0, -1], undefined, hit),
    ).toBe(true)
    expect(hit.entity).toBe(high)
    expect(hit.distance).toBeCloseTo(4.4, 2)
  })

  it('keeps a revolute pendulum at its length, and a rope within its length', async () => {
    const a = await app(2)
    const pivot = a.world.spawn(
      [RigidBody, { kind: 'fixed' }],
      [Transform, { translation: [0, 5, 0] }],
    )
    const bob = ball(a.world, [2, 5, 0], { radius: 0.2 })
    a.world.add(bob, Joint, { kind: 'revolute', other: pivot, anchor: [-2, 0, 0] })
    const anchor = a.world.spawn(
      [RigidBody, { kind: 'fixed' }],
      [Transform, { translation: [10, 5, 0] }],
    )
    const hanging = ball(a.world, [10, 4, 0], { radius: 0.2 })
    a.world.add(hanging, Joint, { kind: 'rope', other: anchor, limits: [0, 3] })
    let lowest = 5
    for (let i = 0; i < 120; i++) {
      a.update(DT)
      const [x, y] = pos(a.world, bob)
      expect(Math.hypot(x!, y! - 5)).toBeCloseTo(2, 1)
      lowest = Math.min(lowest, y!)
    }
    expect(lowest).toBeLessThan(3.1)
    const [hx, hy] = pos(a.world, hanging)
    expect(Math.hypot(hx! - 10, hy! - 5)).toBeCloseTo(3, 1) // fell until the rope went taut
  })

  it('pulls bodies toward a GravitySource from every side', async () => {
    const a = await app(2, (x) => {
      x.world.resource(PhysicsConfig).gravity = [0, 0, 0]
    })
    a.world.spawn(
      [Collider, { shape: 'ball', radius: 5 }],
      [GravitySource, { strength: 9.81, radius: 5 }],
      [Transform, {}],
    )
    const bodies = [
      [0, 10, 0],
      [10, 0, 0],
      [-7, -7, 0],
      [0, -9, 0],
    ].map((s) => ball(a.world, s as [number, number, number]))
    frames(a, 240)
    for (const b of bodies) {
      const [x, y] = pos(a.world, b)
      expect(Math.hypot(x!, y!)).toBeCloseTo(5.5, 1)
    }
  })

  it('attaches child colliders to the ancestor body', async () => {
    const a = await app(2)
    ground(a.world)
    const body = a.world.spawn(
      [RigidBody, { kind: 'dynamic' }],
      [Transform, { translation: [0, 3, 0] }],
    )
    const { ChildOf } = await import('@aethervtt/shard-core')
    for (const x of [-1, 1]) {
      const child = a.world.spawn(
        [Collider, { shape: 'cuboid', halfExtents: [0.5, 0.5, 0] }],
        [Transform, { translation: [x, 0, 0] }],
      )
      a.world.add(child, ChildOf, { parent: body })
    }
    frames(a, 120)
    const p = a.world.resource(Physics)
    expect([...p.colliderOwner.values()].filter((o) => o === body)).toHaveLength(2)
    expect(pos(a.world, body)[1]).toBeCloseTo(0.5, 1)
  })

  it('applies forces, impulses, velocities, mass, and teleports', async () => {
    const a = await app(2, (x) => {
      x.world.resource(PhysicsConfig).gravity = [0, 0, 0]
    })
    const pushed = ball(a.world, [0, 0, 0])
    a.world.add(pushed, Mass, { mass: 2 })
    a.world.add(pushed, ExternalForce, { force: [4, 0, 0] })
    const kicked = ball(a.world, [10, 0, 0])
    a.world.add(kicked, Mass, { mass: 1 })
    a.world.add(kicked, ExternalImpulse, { impulse: [0, 3, 0], torque: [0, 0, 0.5] })
    frames(a, 60)
    expect(a.world.resource(Physics).bodies.get(pushed)!.body.mass()).toBeCloseTo(2, 4)
    expect(a.world.get(pushed, Velocity).linear[0]).toBeCloseTo(2, 1)
    expect(a.world.get(kicked, Velocity).linear[1]).toBeCloseTo(3, 3)
    expect(a.world.get(kicked, Velocity).angular[2]).toBeGreaterThan(0)
    a.world.set(kicked, Velocity, { linear: [-1, 0, 0], angular: [0, 0, 0] })
    a.world.set(kicked, Transform, { translation: [100, 0, 2] })
    frames(a, 60)
    const [x, y, z] = pos(a.world, kicked)
    expect(x).toBeCloseTo(99, 1)
    expect(y).toBeCloseTo(0, 3)
    expect(z).toBe(2) // layer depth stays as written
  })

  it('replays exactly and interpolates on fast displays', async () => {
    const run = async () => {
      const a = await app(2)
      ground(a.world)
      const rng = new Rng(5)
      const list = Array.from({ length: 60 }, () =>
        ball(a.world, [rng.range(-3, 3), rng.range(1, 10), 0], { radius: rng.range(0.2, 0.5) }),
      )
      frames(a, 300)
      return list.flatMap((e) => [...pos(a.world, e), ...a.world.get(e, Transform).rotation])
    }
    expect(await run()).toEqual(await run())
    const a = await app(2, (x) => {
      x.world.resource(PhysicsConfig).interpolate = true
    })
    const b = ball(a.world, [0, 100, 0])
    frames(a, 30, 1 / 144)
    const ys: number[] = []
    for (let i = 0; i < 30; i++) {
      a.update(1 / 144)
      ys.push(pos(a.world, b)[1]!)
    }
    for (let i = 1; i < ys.length; i++) expect(ys[i]!).toBeLessThan(ys[i - 1]!)
  })
})

describe.each(VARIANTS)('on-demand frames (0052, %s)', (v) => {
  useVariant(v)

  it('keeps frames running while a body falls, and stops once it sleeps', async () => {
    const fake = fakeAnimationFrames()
    try {
      const a = await app(3, (a) => ground(a.world))
      a.setRunner(animationFrameRunner({ mode: 'on-demand', measureRefresh: false }))
      const running = a.run()
      for (let i = 0; i < 100 && fake.pending === 0; i++) await Promise.resolve()
      fake.runUntilIdle()
      expect(fake.pending).toBe(0) // only fixed ground: nothing to simulate
      const body = ball(a.world, [0, 3, 0]) // the host's write wakes the app
      const before = a.world.resource(Time).frame
      const ran = fake.runUntilIdle(5000)
      expect(ran).toBeGreaterThan(30)
      expect(a.world.resource(Time).frame - before).toBe(ran)
      expect(fake.pending).toBe(0)
      expect(a.world.resource(FrameDemand).isHeld('physics')).toBe(false)
      expect(a.world.resource(Physics).describe().sleeping).toBe(1)
      expect(pos(a.world, body)[1]).toBeCloseTo(0.5, 1)
      expect(fake.tick()).toBe(0)
      await a.dispose()
      await running
    } finally {
      fake.restore()
    }
  })
})
