import { AnimationPlayer, animationLayer } from '@aethervtt/shard-animation'
import { CharacterStates, CharacterTier } from '@aethervtt/shard-characters'
import { ByteReader, ByteWriter, type Entity } from '@aethervtt/shard-core'
import { timeout } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { Physics } from '@aethervtt/shard-physics'
import { GlobalTransform, Transform } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RagdollAssets } from './asset'
import { bindRagdoll } from './binding'
import { checkRagdoll } from './check'
import { CorpseSettled, GotUp, KnockedDown, Ragdoll, RagdollBudget, Reaction } from './components'
import { castHit, createBoneHit, hitTest } from './hit'
import { qangle, quatFromRows } from './math'
import { reactionCodec } from './net'
import { hit, stand } from './reactions'
import { RagdollSimResource } from './sim'
import { type RagdollCtx, ragdollZombie, startRagdolls, stopRagdolls, walkAt } from './test-app'

const DT = 1 / 60
let gpu: GpuContext
let c: RagdollCtx

beforeAll(async () => {
  gpu = await createNodeGpuContext()
  c = await startRagdolls(gpu)
}, timeout(60_000))

afterAll(async () => {
  if (c) await stopRagdolls(c)
  gpu?.destroy()
})

function frames(n: number): void {
  for (let i = 0; i < n; i++) c.app.update(DT)
}

function joint(e: Entity, name: string): Entity {
  const st = c.world.resource(CharacterStates).get(e)!
  const j = st.rig.jointByName.get(name)!
  return st.rigInstance!.joints[j]!
}

const qa = new Float64Array(4)
const qb = new Float64Array(4)

/** The angle (deg) between the same joint on two characters. */
function apart(a: Entity, b: Entity, name: string): number {
  quatFromRows(qa, 0, c.world.get(joint(a, name), GlobalTransform).matrix, 0)
  quatFromRows(qb, 0, c.world.get(joint(b, name), GlobalTransform).matrix, 0)
  return (qangle(qa, 0, qb, 0) * 180) / Math.PI
}

/** A joint's world position relative to its character's root. */
function local(e: Entity, name: string): number[] {
  const g = c.world.get(joint(e, name), GlobalTransform).matrix
  const r = c.world.get(e, GlobalTransform).matrix
  return [g[3]! - r[3]!, g[7]! - r[7]!, g[11]! - r[11]!]
}

function y(e: Entity, name: string): number {
  return c.world.get(joint(e, name), GlobalTransform).matrix[7]!
}

describe('ragdolls (0117)', () => {
  it('generates 14 humanoid bodies with limits and rest poses', () => {
    const asset = c.world.resource(RagdollAssets).get(c.asset)!
    expect(asset.bodies.map((b) => b.joint).sort()).toEqual(
      [
        'calf_l',
        'calf_r',
        'foot_l',
        'foot_r',
        'head',
        'lowerarm_l',
        'lowerarm_r',
        'pelvis',
        'spine_02',
        'spine_03',
        'thigh_l',
        'thigh_r',
        'upperarm_l',
        'upperarm_r',
      ].sort(),
    )
    expect(asset.bodies.find((b) => b.joint === 'calf_l')!.limits!.kind).toBe('revolute')
    expect(asset.bodies.every((b) => b.rest !== undefined)).toBe(true)
    const mass = asset.bodies.reduce((s, b) => s + b.mass, 0)
    expect(mass).toBeCloseTo(1, 2)
  })

  it('turns the shoulder, chest and head on a partial hit while the legs keep walking', () => {
    const a = ragdollZombie(c, 3, -0.8)
    const b = ragdollZombie(c, 3, 0.8)
    frames(4)
    walkAt(c, a, 0.37)
    walkAt(c, b, 0.37)
    frames(2)
    expect(c.world.get(a, CharacterTier).tier).toBe('near')
    hit(c.world, a, { bone: 'upperarm_l', impulse: [0, 0, -40] })
    expect(c.world.get(a, Reaction).state).toBe('partial')
    let arm = 0
    let chest = 0
    let head = 0
    for (let i = 0; i < 18; i++) {
      frames(1)
      arm = Math.max(arm, apart(a, b, 'upperarm_l'))
      chest = Math.max(chest, apart(a, b, 'spine_03'))
      head = Math.max(head, apart(a, b, 'head'))
      // The legs and pelvis stay on the animation.
      for (const n of ['pelvis', 'foot_l', 'foot_r']) {
        const pa = local(a, n)
        const pb = local(b, n)
        expect(Math.hypot(pa[0]! - pb[0]!, pa[1]! - pb[1]!, pa[2]! - pb[2]!)).toBeLessThan(0.001)
      }
    }
    expect(arm).toBeGreaterThan(15)
    expect(chest).toBeGreaterThan(3)
    expect(head).toBeGreaterThan(3)
    // Back on the animation once it recovers.
    frames(Math.ceil(0.95 / DT))
    expect(c.world.resource(RagdollSimResource).actives.has(a)).toBe(false)
    for (const n of ['upperarm_l', 'spine_03', 'head', 'lowerarm_l', 'pelvis']) {
      expect(apart(a, b, n)).toBeLessThan(0.5)
    }
    c.world.despawn(a)
    c.world.despawn(b)
    frames(1)
  })

  it('keeps a hit leg walking and flinches the torso instead', () => {
    const a = ragdollZombie(c, 3, -0.8)
    const b = ragdollZombie(c, 3, 0.8)
    frames(4)
    walkAt(c, a, 0.37)
    walkAt(c, b, 0.37)
    frames(2)
    hit(c.world, a, { bone: 'calf_l', impulse: [0, 0, -40] })
    let feet = 0
    let chest = 0
    for (let i = 0; i < 18; i++) {
      frames(1)
      for (const n of ['foot_l', 'foot_r', 'calf_l']) {
        const pa = local(a, n)
        const pb = local(b, n)
        feet = Math.max(feet, Math.hypot(pa[0]! - pb[0]!, pa[1]! - pb[1]!, pa[2]! - pb[2]!))
      }
      chest = Math.max(chest, apart(a, b, 'spine_03'))
    }
    expect(feet).toBeLessThan(0.001)
    expect(chest).toBeGreaterThan(2)
    c.world.despawn(a)
    c.world.despawn(b)
    frames(1)
  })

  it('snaps a hit head back fast and eases it back slowly, without overshoot, while walking', () => {
    const a = ragdollZombie(c, 3, -0.8)
    const b = ragdollZombie(c, 3, 0.8)
    frames(4)
    walkAt(c, a, 0.37)
    walkAt(c, b, 0.37)
    // Walking toward the camera by Transform, as the playground's zombies do.
    const step = () => {
      for (const e of [a, b]) {
        const t = c.world.get(e, Transform)
        c.world.set(e, Transform, {
          ...t,
          translation: [t.translation[0], 0, t.translation[2] + 0.9 * DT],
        })
      }
      frames(1)
    }
    step()
    step()
    hit(c.world, a, { bone: 'head', impulse: [0, 0, -55] })
    // The head pushed back (-z) relative to its twin's, frame by frame.
    const dz: number[] = []
    for (let i = 0; i < Math.ceil(1.1 / DT); i++) {
      step()
      dz.push(local(a, 'head')[2]! - local(b, 'head')[2]!)
    }
    const peak = Math.min(...dz)
    const at = dz.indexOf(peak)
    const after = dz.slice(at)
    expect(peak).toBeLessThan(-0.02)
    // Never past the animation the other way (it nodded back and forth before), and back more
    // slowly than it went.
    expect(Math.max(...after)).toBeLessThan(-peak * 0.2)
    const back = after.findIndex((v) => v > peak * 0.1)
    expect(back).toBeGreaterThan(1.3 * (at + 1))
    c.world.despawn(a)
    c.world.despawn(b)
    frames(1)
  })

  it('knocks down on a strong hit, rests on its back, and gets up (drive auto)', () => {
    const a = ragdollZombie(c, 3)
    frames(6)
    const down = c.world.reader(KnockedDown)
    const up = c.world.reader(GotUp)
    down.read()
    up.read()
    hit(c.world, a, { bone: 'spine_03', impulse: [0, 0, -175] })
    expect(c.world.get(a, Reaction).state).toBe('down')
    expect(down.read().length).toBe(1)
    let lowest = Number.POSITIVE_INFINITY
    for (let i = 0; i < 90; i++) {
      frames(1)
      lowest = Math.min(lowest, y(a, 'pelvis'))
    }
    expect(lowest).toBeLessThan(0.4)
    // Rested after downTime (2 s), then the get-up, then standing.
    expect(c.world.get(a, Reaction).rest).toBe(0) // lie-back: hit from the front
    frames(Math.ceil(0.6 / DT))
    // Rested, then (restTime 0) straight into the get-up.
    expect(['rested', 'getting-up']).toContain(c.world.get(a, Reaction).state)
    let stood = false
    for (let i = 0; i < 240 && !stood; i++) {
      frames(1)
      stood = up.read().length > 0
    }
    expect(stood).toBe(true)
    frames(20)
    expect(y(a, 'head')).toBeGreaterThan(1.3)
    c.world.despawn(a)
    frames(1)
  })

  it('freezes a dead ragdoll into a corpse that draws without a rig', () => {
    const a = ragdollZombie(c, 3)
    frames(6)
    const settled = c.world.reader(CorpseSettled)
    settled.read()
    hit(c.world, a, { bone: 'head', impulse: [0, 0, -60], kind: 'death' })
    let done = false
    for (let i = 0; i < 7 * 60 && !done; i++) {
      frames(1)
      done = settled.read().length > 0
    }
    expect(done).toBe(true)
    frames(2)
    const st = c.world.resource(CharacterStates).get(a)!
    expect(st.frozen).not.toBeNull()
    expect(st.rigInstance).toBeNull()
    expect(c.world.get(a, CharacterTier).frozen).toBe(true)
    c.world.despawn(a)
    frames(1)
  })
})

describe('ragdoll check (0117)', () => {
  it('reads a ragdoll standing at rest as within its limits', async () => {
    const asset = c.world.resource(RagdollAssets).get(c.asset)!
    const b = bindRagdoll(asset, c.rig.skeleton, c.rig.builds[0]!.rest)
    const r = await checkRagdoll(b, { trials: 1, min: 0, max: 0, settle: 0.05 })
    expect(r.nan).toBe(0)
    expect(r.worstPastLimitDeg).toBeLessThan(1)
  })

  it(
    'keeps random hits within its limits, above the ground, and finite',
    async () => {
      const asset = c.world.resource(RagdollAssets).get(c.asset)!
      const b = bindRagdoll(asset, c.rig.skeleton, c.rig.builds[0]!.rest)
      const r = await checkRagdoll(b, { trials: 20 })
      expect(r).toMatchObject({ nan: 0, below: 0 })
      expect(r.worstPastLimitDeg).toBeLessThanOrEqual(5)
    },
    timeout(60_000),
  )
})

describe('hit tests, roles and drives (0117)', () => {
  it('hits the same bone at the same point near and far (the pose sampled on demand)', () => {
    const a = ragdollZombie(c, 4)
    frames(6)
    c.world.set(a, AnimationPlayer, {
      ...c.world.get(a, AnimationPlayer),
      layers: [animationLayer(c.fixture.clips.walk.clip, { time: 0.4, playing: false })],
    })
    frames(3)
    expect(c.world.get(a, CharacterTier).tier).toBe('near')
    const head = c.world.get(joint(a, 'head'), GlobalTransform).matrix
    const target = [head[3]!, head[7]! + 0.08, head[11]!]
    const origin = [0, 1.5, 0]
    const dir = target.map((v, k) => v - origin[k]!)
    const near = createBoneHit()
    expect(hitTest(c.world, a, origin, dir, near)).toBe(true)
    expect(near.bone).toBe('head')
    // Out of view: the camera turned away, so the character drops to off and has no rig.
    const cam = structuredClone(c.world.get(c.camera, Transform))
    c.world.set(c.camera, Transform, { ...cam, rotation: [0, 1, 0, 0] })
    frames(3)
    expect(c.world.get(a, CharacterTier).tier).toBe('off')
    const off = createBoneHit()
    expect(hitTest(c.world, a, origin, dir, off)).toBe(true)
    expect(off.bone).toBe('head')
    expect(Math.hypot(...[0, 1, 2].map((k) => off.point[k]! - near.point[k]!))).toBeLessThan(0.01)
    c.world.set(c.camera, Transform, cam)
    c.world.despawn(a)
    frames(2)
  })

  it('castHit finds the bone through the root’s sensor capsule', () => {
    const a = ragdollZombie(c, 4)
    frames(8)
    const head = c.world.get(joint(a, 'head'), GlobalTransform).matrix
    const origin = [0, 1.5, 0]
    const dir = [head[3]! - 0, head[7]! + 0.05 - 1.5, head[11]! - 0]
    const h = castHit(c.world, origin, dir, { maxDistance: 20 })
    expect(h?.root).toBe(a)
    expect(h?.bone).toBe('head')
    // A ray beside the body misses it, through the capsule.
    const miss = castHit(c.world, [0.7, 1.0, 0], [0.12, 0, -1], { maxDistance: 8 })
    expect(miss === undefined || miss.root !== a).toBe(true)
    c.world.despawn(a)
    frames(2)
  })

  it('hit-tests a plain root with no skeleton against the asset’s rest', () => {
    const root = c.world.spawn(
      [Transform, { translation: [5, 0, -6] }],
      [Ragdoll, { asset: c.asset }],
    )
    frames(2)
    const h = createBoneHit()
    const asset = c.world.resource(RagdollAssets).get(c.asset)!
    const head = asset.bodies.find((b) => b.joint === 'head')!.rest!
    expect(hitTest(c.world, root, [5 + head[0]!, head[1]! + 0.05, 0], [0, 0, -1], h)).toBe(true)
    expect(h.bone).toBe('head')
    c.world.despawn(root)
  })

  it('stops at rested with drive game, plays no clip, and stands on stand()', () => {
    const a = ragdollZombie(c, 3, 0, 'game')
    frames(6)
    const layers = c.world.get(a, AnimationPlayer).layers.length
    const up = c.world.reader(GotUp)
    up.read()
    hit(c.world, a, { bone: 'spine_03', impulse: [0, 0, -200] })
    frames(Math.ceil(2.6 / DT))
    expect(c.world.get(a, Reaction).state).toBe('rested')
    expect(c.world.get(a, AnimationPlayer).layers.length).toBe(layers)
    frames(60)
    expect(c.world.get(a, Reaction).state).toBe('rested')
    stand(c.world, a)
    expect(c.world.get(a, Reaction).state).toBe('none')
    expect(up.read().length).toBe(1)
    c.world.despawn(a)
    frames(2)
  })

  it('launches every body at the launch velocity (a car)', () => {
    const a = ragdollZombie(c, 3)
    frames(6)
    hit(c.world, a, { launch: [0, 3, -8] })
    expect(c.world.get(a, Reaction).state).toBe('down')
    // Activation lands on the next fixed steps.
    frames(3)
    const sim = c.world.resource(RagdollSimResource)
    const act = sim.actives.get(a)!
    expect(act.pending).toBe(false)
    const p = c.world.resource(Physics)
    let vz = 0
    for (const e of act.slot!.bodies) vz += p.bodies.get(e)!.body.linvel().z
    expect(vz / act.slot!.bodies.length).toBeLessThan(-5)
    c.world.despawn(a)
    frames(2)
  })

  it('flies a car hit without a jump, and lies down where it landed', () => {
    const a = ragdollZombie(c, 4)
    frames(6)
    hit(c.world, a, { launch: [0, 3.5, -9] })
    const pelvis = () => {
      const m = c.world.get(joint(a, 'pelvis'), GlobalTransform).matrix
      return [m[3]!, m[7]!, m[11]!]
    }
    let last = pelvis()
    let jump = 0
    let landed: number[] = last
    let restMove = 0
    for (let i = 0; i < Math.ceil(3 / DT); i++) {
      frames(1)
      const now = pelvis()
      const step = Math.hypot(now[0]! - last[0]!, now[2]! - last[2]!)
      jump = Math.max(jump, step)
      const st = c.world.get(a, Reaction).state
      if (st === 'down') landed = now
      else if (st === 'rested')
        restMove = Math.max(restMove, Math.hypot(now[0]! - landed[0]!, now[2]! - landed[2]!))
      last = now
    }
    // 9 m/s is 0.15 m a frame: nothing teleports.
    expect(jump).toBeLessThan(0.3)
    // It flew a long way, and rests where it came down rather than sliding to a predicted spot.
    expect(Math.abs(landed[2]! - -4)).toBeGreaterThan(2)
    expect(restMove).toBeLessThan(0.35)
    c.world.despawn(a)
    frames(2)
  })

  it('round-trips a Reaction through its 16-byte codec', () => {
    const codec = reactionCodec(Reaction)
    const w = new ByteWriter()
    codec.encode(
      {
        state: 'down',
        launch: true,
        bone: 3,
        rest: 1,
        role: 7,
        impulse: [1.5, -200, 8],
        seq: 513,
        since: 12.25,
        stagger: 0.4,
      },
      w,
    )
    const bytes = w.finish()
    expect(bytes.length).toBe(16)
    const back = codec.decode(new ByteReader(bytes)) as Record<string, unknown>
    expect(back).toMatchObject({
      state: 'down',
      launch: true,
      bone: 3,
      rest: 1,
      role: 7,
      seq: 513,
      since: 12.25,
    })
    expect((back.impulse as number[])[1]).toBeCloseTo(-200, 0)
  })

  it('plays a role clip on top while the physics reacts (drive auto)', () => {
    const a = ragdollZombie(c, 3)
    frames(6)
    const asset = c.world.resource(RagdollAssets).get(c.asset)!
    // The idle clip stands in for a light hit, as an additive layer.
    asset.roles.set('hit.light', { clips: ['idle'], blend: 'additive', travel: undefined })
    asset.roleNames = [...asset.roles.keys()].sort()
    const before = c.world.get(a, AnimationPlayer).layers.length
    hit(c.world, a, { bone: 'upperarm_r', impulse: [0, 0, -20] })
    frames(2)
    const layers = c.world.get(a, AnimationPlayer).layers
    expect(layers.length).toBe(before + 1)
    expect(layers[layers.length - 1]!.blend).toBe('additive')
    asset.roles.delete('hit.light')
    asset.roleNames = [...asset.roles.keys()].sort()
    c.world.despawn(a)
    frames(2)
  })
})

describe('under fire (0117)', () => {
  it('simulates at most maxActive at once, the largest on screen; the rest show clips only', () => {
    const budget = c.world.resource(RagdollBudget)
    const keep = budget.maxActive
    budget.maxActive = 4
    const zs = Array.from({ length: 8 }, (_, k) => ragdollZombie(c, 3 + (k % 4), (k - 3.5) * 0.9))
    frames(6)
    const sim = c.world.resource(RagdollSimResource)
    const before = sim.stats.fallbacks
    const evictions = sim.stats.evictions
    for (const z of zs) hit(c.world, z, { bone: 'spine_03', impulse: [0, 0, -30] })
    let worst = 0
    for (let i = 0; i < 10; i++) {
      frames(1)
      let n = 0
      for (const a of sim.actives.values()) if (a.slot) n++
      worst = Math.max(worst, n)
    }
    // The largest on screen simulate: smaller ones lose their slot (evicted) or never get one.
    expect(worst).toBe(4)
    expect(sim.stats.fallbacks - before + (sim.stats.evictions - evictions)).toBe(4)
    budget.maxActive = keep
    for (const z of zs) c.world.despawn(z)
    frames(2)
  })
})
