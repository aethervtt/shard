import { ShardError } from '@aethervtt/shard-core'
import { allocationChecks, budget, gcWindow } from '@aethervtt/shard-core/test-env'
import { describe, expect, it } from 'vitest'
import golden from './golden.json'
import {
  decodeTrack,
  encodeTrack,
  recordTrack,
  sampleTrack,
  sceneHash,
  TRACK_ENGINE,
  type Track,
  type TrackScene,
  trackHash,
  trackSceneFromJson,
  trackSceneToJson,
} from './index'
import { trayScene } from './test-scenes'

/** The golden track's hash, recorded once in Node; the embedding demo checks it in Chromium. */
export const GOLDEN_HASH = 0x5d32645f

const hex = (h: number) => h.toString(16).padStart(8, '0')
const goldenScene = () => trackSceneFromJson(golden.scene)

async function rejection(p: Promise<unknown>): Promise<ShardError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(ShardError)
  return err as ShardError
}

/** One falling ball over a floor. */
function ballScene(overrides: Partial<TrackScene> = {}): TrackScene {
  return {
    version: 1,
    dim: 3,
    step: 1 / 60,
    maxSteps: 300,
    gravity: [0, -9.81, 0],
    fixed: [
      {
        shape: 'cuboid',
        halfExtents: [5, 0.5, 5],
        translation: [0, -0.5, 0],
        friction: 0.5,
        restitution: 0,
        density: 1,
      },
    ],
    bodies: [
      {
        id: 'ball',
        translation: [0, 2, 0],
        rotation: [0, 0, 0, 1],
        linear: [0, 0, 0],
        angular: [0, 0, 0],
        colliders: [{ shape: 'ball', radius: 0.5, friction: 0.5, restitution: 0, density: 1 }],
      },
    ],
    ...overrides,
  }
}

describe('recording', () => {
  it('records the golden track: the same hash across 10 runs, matching the committed one', async () => {
    expect(golden.hash).toBe(hex(GOLDEN_HASH))
    const hashes = new Set<number>()
    for (let i = 0; i < 10; i++) {
      const track = await recordTrack(goldenScene(), { contacts: golden.contacts })
      hashes.add(trackHash(track))
      expect(track.steps).toBe(golden.steps)
    }
    expect([...hashes].map(hex)).toEqual([hex(GOLDEN_HASH)])
  })

  it('writes every pose from step 0, and ends when every body sleeps', async () => {
    const scene = ballScene()
    const track = await recordTrack(scene)
    expect(track.engine).toBe(TRACK_ENGINE)
    expect(track.sceneHash).toBe(sceneHash(scene))
    expect(track.settled).toBe(true)
    expect(track.maxStepsHit).toBe(false)
    expect(track.positions.length).toBe((track.steps + 1) * 3)
    expect(track.rotations.length).toBe((track.steps + 1) * 4)
    expect(Array.from(track.positions.subarray(0, 3))).toEqual([0, 2, 0])
    // Resting on the floor at the end.
    expect(track.positions[track.steps * 3 + 1]).toBeCloseTo(0.5, 2)
  })

  it('runs to maxSteps when the rule never settles, and says so', async () => {
    const track = await recordTrack(ballScene({ maxSteps: 150 }), { settle: () => 'continue' })
    expect(track.steps).toBe(150)
    expect(track.settled).toBe(false)
    expect(track.maxStepsHit).toBe(true)
  })

  it('shows settle rules the step, sleeping flags and poses', async () => {
    const seen: number[] = []
    const pos = new Float64Array(3)
    const rot = new Float64Array(4)
    const track = await recordTrack(ballScene(), {
      settle: (view) => {
        seen.push(view.step)
        view.pose(0, pos, rot)
        return view.step === 40 ? 'done' : 'continue'
      },
    })
    expect(seen).toEqual(Array.from({ length: 40 }, (_, i) => i + 1))
    expect(track.steps).toBe(40)
    expect(pos[1]).toBe(track.positions[40 * 3 + 1])
    expect(rot[3]).toBe(track.rotations[40 * 4 + 3])
  })

  it('applies a phase: disabled groups stop colliding, and bodies wake', async () => {
    const scene = ballScene({
      groups: { floor: { layers: 2, mask: 1 }, ball: { layers: 1, mask: 2 } },
    })
    scene.fixed[0]!.group = 'floor'
    scene.bodies[0]!.colliders[0]!.group = 'ball'
    let sleptAt = 0
    const track = await recordTrack(scene, {
      settle: (view) => {
        if (view.sleeping[0] && !sleptAt) {
          sleptAt = view.step
          return { disableGroups: ['floor'], wake: true }
        }
        return view.step >= sleptAt + 60 && sleptAt > 0 ? 'done' : 'continue'
      },
    })
    expect(sleptAt).toBeGreaterThan(0)
    // Resting when the floor went away, then falling through where it was.
    expect(track.positions[sleptAt * 3 + 1]).toBeCloseTo(0.5, 2)
    expect(track.positions[track.steps * 3 + 1]).toBeLessThan(-2)
  })

  it('records contacts over a minimum force, deduplicated, with -1 for fixed colliders', async () => {
    const track = await recordTrack(goldenScene(), { contacts: golden.contacts })
    const c = track.contacts
    expect(c.steps.length).toBeGreaterThan(0)
    for (let i = 0; i < c.steps.length; i++) {
      expect(c.force[i]).toBeGreaterThanOrEqual(0.5)
      expect(c.a[i]).toBeGreaterThanOrEqual(0)
      expect(c.b[i] === -1 || c.b[i]! > c.a[i]!).toBe(true)
      if (i > 0) expect(c.steps[i]).toBeGreaterThanOrEqual(c.steps[i - 1]!)
    }
    expect([...c.b].some((b) => b === -1)).toBe(true)
    const capped = await recordTrack(goldenScene(), { contacts: { ...golden.contacts, max: 5 } })
    expect(capped.contacts.steps.length).toBe(5)
    const none = await recordTrack(goldenScene())
    expect(none.contacts.steps.length).toBe(0)
  })

  it('fails with physics/track-diverged naming the body and step', async () => {
    const scene = ballScene()
    // Finite in f64, infinite in Rapier's f32.
    scene.bodies[0]!.translation = [1e39, 0, 0]
    const err = await rejection(recordTrack(scene))
    expect(err.code).toBe('physics/track-diverged')
    expect(err.message).toBe('Body "ball" left finite numbers at step 0')
    expect(err.path).toBe('bodies[0]')
  })

  it('rejects invalid scenes with physics/track-scene and a path', async () => {
    const cases: [string, (s: TrackScene) => void][] = [
      ['step', (s) => Object.assign(s, { step: 0 })],
      ['maxSteps', (s) => Object.assign(s, { maxSteps: 70_000 })],
      [
        'bodies[0].colliders[0].radius',
        (s) => Object.assign(s.bodies[0]!.colliders[0]!, { radius: -1 }),
      ],
      [
        'bodies[0].colliders[0].group',
        (s) => Object.assign(s.bodies[0]!.colliders[0]!, { group: 'nope' }),
      ],
      ['bodies[1].id', (s) => s.bodies.push({ ...s.bodies[0]! })],
      ['bodies[0].linear[1]', (s) => Object.assign(s.bodies[0]!, { linear: [0, Number.NaN, 0] })],
    ]
    for (const [path, change] of cases) {
      const scene = ballScene()
      change(scene)
      const err = await rejection(recordTrack(scene))
      expect(err.code).toBe('physics/track-scene')
      expect(err.path).toBe(path)
    }
  })
})

describe('cancellation', () => {
  it('rejects within 10 ms of an abort with physics/track-cancelled, then records again', async () => {
    const abort = new AbortController()
    let abortedAt = 0
    const running = recordTrack(trayScene(32, 3, 4000), {
      signal: abort.signal,
      settle: (view) => {
        if (view.step === 70) {
          abortedAt = performance.now()
          abort.abort()
        }
        return 'continue'
      },
    })
    const err = await rejection(running)
    const latency = performance.now() - abortedAt
    expect(err.code).toBe('physics/track-cancelled')
    expect(latency).toBeLessThan(budget(10))
    const again = await recordTrack(goldenScene(), { contacts: golden.contacts })
    expect(trackHash(again)).toBe(GOLDEN_HASH)
  })

  it('rejects at once when the signal is already aborted', async () => {
    const err = await rejection(recordTrack(ballScene(), { signal: AbortSignal.abort() }))
    expect(err.code).toBe('physics/track-cancelled')
  })
})

describe('format', () => {
  it('encodes to one buffer and decodes to an equal track, views and all', async () => {
    const track = await recordTrack(goldenScene(), { contacts: golden.contacts })
    const buffer = encodeTrack(track)
    const back = decodeTrack(buffer)
    expect(trackHash(back)).toBe(trackHash(track))
    expect(back.positions.buffer).toBe(buffer)
    const { positions, rotations, contacts, ...header } = back
    const { positions: p, rotations: r, contacts: c, ...expected } = track
    expect(header).toEqual(expected)
    expect(positions).toEqual(p)
    expect(rotations).toEqual(r)
    expect(contacts).toEqual(c)
  })

  it('leaves simulationMs out of the hash', async () => {
    const track = await recordTrack(ballScene())
    const other: Track = { ...track, simulationMs: track.simulationMs + 5 }
    expect(trackHash(other)).toBe(trackHash(track))
  })

  it('refuses another engine or version with physics/track-version, and garbage with track-invalid', async () => {
    const track = await recordTrack(ballScene())
    const other = encodeTrack({ ...track, engine: 'rapier3d-deterministic@0.21.0' })
    expect(() => decodeTrack(other)).toThrow(
      expect.objectContaining({ code: 'physics/track-version' }),
    )
    expect(decodeTrack(other, { engine: null }).engine).toBe('rapier3d-deterministic@0.21.0')
    const newer = encodeTrack(track)
    new DataView(newer).setUint32(4, 2, true)
    expect(() => decodeTrack(newer)).toThrow(
      expect.objectContaining({ code: 'physics/track-version' }),
    )
    expect(() => decodeTrack(new ArrayBuffer(8))).toThrow(
      expect.objectContaining({ code: 'physics/track-invalid' }),
    )
    expect(() => decodeTrack(encodeTrack(track).slice(0, 100))).toThrow(
      expect.objectContaining({ code: 'physics/track-invalid' }),
    )
  })

  it('hashes scenes canonically: defaults and group order do not matter, values do', () => {
    const a = ballScene({ groups: { x: { layers: 1, mask: 1 }, y: { layers: 2, mask: 2 } } })
    const b = ballScene({ groups: { y: { layers: 2, mask: 2 }, x: { layers: 1, mask: 1 } } })
    b.bodies[0]!.canSleep = true
    b.bodies[0]!.ccd = false
    b.bodies[0]!.linearDamping = 0
    expect(sceneHash(a)).toBe(sceneHash(b))
    b.bodies[0]!.translation = [0, 2.0000001, 0]
    expect(sceneHash(a)).not.toBe(sceneHash(b))
    // Through JSON and back, convex points included.
    const scene = goldenScene()
    expect(sceneHash(trackSceneFromJson(JSON.parse(JSON.stringify(trackSceneToJson(scene)))))).toBe(
      sceneHash(scene),
    )
  })
})

describe('sampling', () => {
  it('returns recorded poses at steps, and interpolates between them', async () => {
    const track = await recordTrack(goldenScene())
    const pos = new Float64Array(3)
    const rot = new Float64Array(4)
    const n = track.bodyCount
    sampleTrack(track, 30 * track.step, 2, pos, rot)
    expect(pos[0]).toBeCloseTo(track.positions[(30 * n + 2) * 3]!, 5)
    expect(rot[3]).toBeCloseTo(track.rotations[(30 * n + 2) * 4 + 3]!, 5)
    sampleTrack(track, 30.5 * track.step, 2, pos, rot)
    const a = track.positions[(30 * n + 2) * 3 + 1]!
    const b = track.positions[(31 * n + 2) * 3 + 1]!
    expect(pos[1]).toBeCloseTo((a + b) / 2, 5)
    expect(Math.hypot(rot[0]!, rot[1]!, rot[2]!, rot[3]!)).toBeCloseTo(1, 6)
    // Clamped to the track.
    sampleTrack(track, -1, 0, pos, rot)
    expect(pos[0]).toBeCloseTo(track.positions[0]!, 6)
    sampleTrack(track, 1e6, 0, pos, rot)
    expect(pos[0]).toBeCloseTo(track.positions[track.steps * n * 3]!, 6)
    expect(() => sampleTrack(track, 0, n, pos, rot)).toThrow(
      expect.objectContaining({ code: 'physics/track-body' }),
    )
  })
})

describe('performance (bench)', () => {
  it('records 32 convex bodies over 480 steps in under 100 ms', async () => {
    const scene = trayScene(32, 1, 480)
    await recordTrack(ballScene()) // Rapier loaded and warm
    let best = Number.POSITIVE_INFINITY
    for (let i = 0; i < 3; i++) {
      const start = performance.now()
      const track = await recordTrack(scene, { settle: () => 'continue' })
      best = Math.min(best, performance.now() - start)
      expect(track.steps).toBe(480)
    }
    expect(best).toBeLessThan(budget(100))
  })

  it('samples 10k poses without allocating', async () => {
    const track = await recordTrack(goldenScene())
    const pos = new Float64Array(3)
    const rot = new Float64Array(4)
    const sample = (k: number) => {
      for (let i = 0; i < 10_000; i++) {
        sampleTrack(track, (i % 600) * 0.0071 + k, i % track.bodyCount, pos, rot)
      }
    }
    for (let k = 0; k < 20; k++)
      sample(k * 1e-4) // optimized before measuring
    ;(globalThis as { gc?: () => void }).gc?.()
    const window = gcWindow()
    sample(0.5)
    const collections = await window.end()
    if (allocationChecks) expect(collections).toBe(0)
    expect(Number.isFinite(pos[0])).toBe(true)
  })
})
