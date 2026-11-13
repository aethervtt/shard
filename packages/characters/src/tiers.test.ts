import {
  AnimationPlayer,
  AnimationStateResource,
  animationLayer,
  TwoBoneIk,
} from '@aethervtt/shard-animation'
import { ChildOf, type Entity } from '@aethervtt/shard-core'
import { timeout } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { ComputedVisibility, Mesh3d, Meshes, SkinPose, Visibility } from '@aethervtt/shard-render'
import { deformedPositions } from '@aethervtt/shard-render/testing'
import { Transform } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CharacterPart, CharacterTier, FAR, MID, NEAR, OFF } from './components'
import type { charactersPlugin } from './plugin'
import { jointEntityCount } from './rigs'
import { CharacterStates, partsOf, spawnCharacter } from './spawn'
import { type Ctx, startCharacters, stopCharacters, zombie } from './test-app'
import { TierRunResource } from './tiers'

let gpu: GpuContext | undefined
const contexts: Ctx[] = []

beforeAll(async () => {
  gpu = await createNodeGpuContext().catch(() => undefined)
})

afterAll(async () => {
  for (const c of contexts) await stopCharacters(c)
})

async function start(budget: Parameters<typeof charactersPlugin>[0] = {}): Promise<Ctx> {
  const c = await startCharacters(gpu!, budget)
  contexts.push(c)
  return c
}

const tierOf = (c: Ctx, e: Entity) => c.world.get(e, CharacterTier).tier

describe('character tiers (0115)', () => {
  it('builds the rig from the MakeHuman body: 53 joints, builds, rest sphere', {
    timeout: timeout(60_000),
  }, async () => {
    if (!gpu) return
    const c = await start()
    expect(c.rig.skeleton.paths.length).toBe(53)
    expect([...c.rig.skeleton.parents].filter((p) => p < 0).length).toBe(1)
    const heavy = c.rig.builds.find((b) => b.name === 'heavy')!
    const plain = c.rig.builds[0]!
    let moved = 0
    for (let k = 0; k < plain.rest.length; k++)
      if (Math.abs(heavy.rest[k]! - plain.rest[k]!) > 1e-6) moved++
    expect(moved).toBeGreaterThan(0)
    // 1.66 m tall body: the rest sphere spans it.
    expect(c.rig.restSphere[3]).toBeGreaterThan(0.8)
    expect(c.rig.restSphere[3]).toBeLessThan(1.5)
  })

  it('chooses tiers by screen size, with caps and pins; joint entities follow near only', {
    timeout: timeout(120_000),
  }, async () => {
    if (!gpu) return
    const c = await start({ maxNear: 2, maxMid: 3 })
    const near = [2.5, 3, 4].map((d) => zombie(c, d))
    const mid = [20, 30].map((d) => zombie(c, d))
    const far = [120, 300].map((d) => zombie(c, d))
    const behind = zombie(c, -10)
    for (let f = 0; f < 3; f++) c.app.update(1 / 60)
    // Caps: 3 want near, 2 get it; the third waits at mid.
    expect(near.map((e) => tierOf(c, e)).sort()).toEqual(['mid', 'near', 'near'])
    expect(mid.map((e) => tierOf(c, e))).toEqual(['mid', 'mid'])
    // maxMid 3: the near overflow plus two mid fit; the far ones are far.
    expect(far.map((e) => tierOf(c, e))).toEqual(['far', 'far'])
    expect(tierOf(c, behind)).toBe('off')
    // A pinned character is near anywhere, and doesn't take a near slot.
    c.world.set(far[1]!, CharacterTier, { pin: true })
    c.world.set(behind, CharacterTier, { pin: true })
    c.app.update(1 / 60)
    expect(tierOf(c, far[1]!)).toBe('near')
    expect(tierOf(c, behind)).toBe('near')
    expect(near.filter((e) => tierOf(c, e) === 'near').length).toBe(2)
    const joints = jointEntityCount(c.world)
    expect(joints).toBeLessThanOrEqual((2 + 2 + 4) * 53)
    // A hundred more far away: no new joint entities.
    for (let k = 0; k < 100; k++) zombie(c, 150 + k, { x: (k % 10) - 5 })
    for (let f = 0; f < 3; f++) c.app.update(1 / 60)
    expect(jointEntityCount(c.world)).toBe(joints)
  })

  it('keeps the skinned vertices across every swap, both ways', {
    timeout: timeout(120_000),
  }, async () => {
    if (!gpu) return
    const c = await start()
    const e = zombie(c, 0, { build: 'heavy', morphs: { 'muscle-max': 0.5 } })
    const state = c.world.resource(CharacterStates).get(e)!
    const torso = state.parts.find((p) => c.world.get(p, CharacterPart).name === 'body-torso')!
    const at = (d: number) => {
      // Move the camera, not the character, so world positions compare directly.
      c.world.set(c.camera, Transform, { translation: [0, 1.5, d] })
    }
    at(2.5)
    for (let f = 0; f < 5; f++) c.app.update(1 / 60)
    expect(tierOf(c, e)).toBe('near')
    const n = 40000
    const before = new Float32Array(n * 3)
    const after = new Float32Array(n * 3)
    // At far the torso draws inside the merged body: its vertices start after the parts before it.
    const meshes = c.world.resource(Meshes)
    let offset = 0
    for (const part of state.parts) {
      const p = c.world.get(part, CharacterPart)
      if (p.name === 'body-torso') break
      if (/^body-/.test(p.name)) {
        offset += meshes.get(c.world.get(part, Mesh3d).mesh)!.vertexCount
      }
    }
    const torsoAt = (tier: number, out: Float32Array): number => {
      if (tier !== FAR) return deformedPositions(c.world, torso, out)
      const all = new Float32Array(n * 3)
      deformedPositions(c.world, state.merged!, all)
      const count = meshes.get(c.world.get(torso, Mesh3d).mesh)!.vertexCount
      out.set(all.subarray(offset * 3, (offset + count) * 3))
      return count
    }
    const swap = (d: number, expected: number, tolerance: number) => {
      const was = c.world.resource(CharacterStates).get(e)!.tier
      const count = torsoAt(was, before)
      at(d)
      c.app.update(0)
      expect(c.world.resource(CharacterStates).get(e)!.tier).toBe(expected)
      if (expected === OFF) return 0
      const count2 = torsoAt(expected, after)
      expect(count2).toBe(count)
      let worst = 0
      for (let k = 0; k < count * 3; k += 3) {
        const dx = after[k]! - before[k]!
        const dy = after[k + 1]! - before[k + 1]!
        const dz = after[k + 2]! - before[k + 2]!
        worst = Math.max(worst, Math.sqrt(dx * dx + dy * dy + dz * dz))
      }
      if (process.env.DEBUG_TIERS) console.log(`swap to ${expected} at ${d} m: worst ${worst} m`)
      expect(worst).toBeLessThanOrEqual(tolerance)
      return worst
    }
    // 0.5 px at the swap distance, at 360 rows and 60°.
    const px = (d: number) => (0.5 * d * 2 * Math.tan(Math.PI / 6)) / 360
    swap(25, MID, 1e-4)
    swap(250, FAR, px(250))
    swap(25, MID, px(250))
    swap(2.5, NEAR, 1e-4)
    // The next frame skins by the rig the player sampled: still the same vertices.
    swap(2.5, NEAR, 1e-4)
    // Off and back: nothing drawn, then the pose at this frame's time.
    swap(-5, OFF, Number.POSITIVE_INFINITY)
  })
})

describe('IK across swaps (0115)', () => {
  it('fades IK out before leaving near, so the swap keeps the vertices', {
    timeout: timeout(120_000),
  }, async () => {
    if (!gpu) return
    const c = await start({ ikFade: 0.2 })
    const e = zombie(c, 0)
    // Freeze the clip: only the IK fade moves the pose.
    c.world.set(e, AnimationPlayer, {
      layers: [animationLayer(c.fixture.clips.walk.clip, { time: 0.4, playing: false })],
    })
    const target = c.world.spawn([Transform, { translation: [0.3, 0.3, 0.4] }])
    const pole = c.world.spawn([Transform, { translation: [0, 0.5, 2] }])
    const leg = 'Human.rig/Root/pelvis'
    c.world.spawn(
      [
        TwoBoneIk,
        {
          root: `${leg}/thigh_l`,
          mid: `${leg}/thigh_l/calf_l`,
          tip: `${leg}/thigh_l/calf_l/foot_l`,
          target,
          pole,
          weight: 1,
        },
      ],
      [ChildOf, { parent: e }],
    )
    c.world.set(c.camera, Transform, { translation: [0, 1.5, 2.5] })
    for (let f = 0; f < 30; f++) c.app.update(1 / 60)
    const states = c.world.resource(CharacterStates)
    const st = states.get(e)!
    expect(st.tier).toBe(NEAR)
    expect(st.ik).toBe(1)
    const torso = st.parts.find((p) => c.world.get(p, CharacterPart).name === 'body-lower-legs')!
    const solved = new Float32Array(30000)
    deformedPositions(c.world, torso, solved)
    // Move away: IK fades over 0.2 s (12 frames) before the swap.
    c.world.set(c.camera, Transform, { translation: [0, 1.5, 25] })
    const before = new Float32Array(30000)
    const after = new Float32Array(30000)
    let frames = 0
    let count = 0
    while (st.tier === NEAR && frames < 60) {
      count = deformedPositions(c.world, torso, before)
      c.app.update(1 / 60)
      frames++
    }
    expect(st.tier).toBe(MID)
    expect(frames).toBeGreaterThanOrEqual(12)
    deformedPositions(c.world, torso, after)
    let worst = 0
    let moved = 0
    for (let k = 0; k < count * 3; k += 3) {
      const d = Math.hypot(
        after[k]! - before[k]!,
        after[k + 1]! - before[k + 1]!,
        after[k + 2]! - before[k + 2]!,
      )
      worst = Math.max(worst, d)
      moved = Math.max(
        moved,
        Math.hypot(
          solved[k]! - after[k]!,
          solved[k + 1]! - after[k + 1]!,
          solved[k + 2]! - after[k + 2]!,
        ),
      )
    }
    // IK really moved the leg, and the swap itself moved nothing.
    expect(moved).toBeGreaterThan(0.02)
    expect(worst).toBeLessThanOrEqual(1e-4)
  })
})

describe('composed characters, sampling and sim ticks (0115)', () => {
  it('parts share one pose range, one header and one bake; foreign skins are refused', {
    timeout: timeout(120_000),
  }, async () => {
    if (!gpu) return
    const c = await start()
    const a = zombie(c, 25, { morphs: { 'muscle-max': 0.3 } })
    const b = zombie(c, 25, { x: 2, morphs: { 'weight-min': 0.6 } })
    c.app.update(1 / 60)
    const states = c.world.resource(CharacterStates)
    const sa = states.get(a)!
    expect(sa.tier).toBe(MID)
    const drawn = (st: typeof sa) =>
      st.parts.filter((p) => c.world.get(p, Visibility).mode !== 'hidden')
    const bases = new Set(drawn(sa).map((p) => c.world.get(p, SkinPose).base))
    expect(bases.size).toBe(1)
    expect([...bases][0]).toBe(sa.poseBase)
    // The face parts: eyes and brows draw at mid, lashes only near.
    const names = drawn(sa).map((p) => c.world.get(p, CharacterPart).name)
    expect(names).toContain('eyes')
    expect(names).not.toContain('eyelashes')
    // Far: one header for every drawn part, the merged body instead of the regions, one bake.
    c.world.set(c.camera, Transform, { translation: [0, 1.5, 230] })
    c.app.update(1 / 60)
    expect(sa.tier).toBe(FAR)
    // Only the merged body draws: the regions merge, eyes and brows stop at mid, lashes at near.
    expect(drawn(sa)).toEqual([])
    expect(c.world.get(sa.merged!, SkinPose).base).toBe(sa.header)
    expect(c.world.get(sa.merged!, SkinPose).source).toBe('baked')
    expect(c.world.get(sa.merged!, Visibility).mode).not.toBe('hidden')
    expect(drawn(sa).some((p) => /^body-/.test(c.world.get(p, CharacterPart).name))).toBe(false)
    const sb = states.get(b)!
    expect(sb.tier).toBe(FAR)
    expect(c.rig.builds[0]!.bake).toBeDefined()
    expect(c.rig.builds.filter((x) => x.bake).length).toBe(1)
    // A part skinned to another skeleton.
    const foreign = partsOf(c.world, c.model)
      .slice(0, 1)
      .map((p) => ({
        ...p,
        components: {
          ...p.components,
          'render/SkinnedMesh': { skin: { path: c.fixture.clips.walk.skinPath } },
        },
      }))
    expect(() => spawnCharacter(c.world, c.rig, { parts: foreign })).toThrow(/skeleton/)
  })

  it('samples nothing off screen, and draws what a turn brings into view that frame', {
    timeout: timeout(120_000),
  }, async () => {
    if (!gpu) return
    const c = await start({ maxNear: 4, maxMid: 40 })
    const ahead: Entity[] = []
    const behind: Entity[] = []
    for (let k = 0; k < 20; k++) {
      ahead.push(zombie(c, 3 + k * 2, { x: (k % 5) - 2 }))
      behind.push(zombie(c, -(3 + k * 2), { x: (k % 5) - 2 }))
    }
    for (let f = 0; f < 6; f++) c.app.update(1 / 60)
    const states = c.world.resource(CharacterStates)
    for (const e of behind) expect(states.get(e)!.tier).toBe(OFF)
    const run = c.world.resource(TierRunResource).run!
    const midResampled = run.stats.jointsSampled / 53
    expect(Number.isInteger(midResampled)).toBe(true)
    expect(midResampled).toBeLessThanOrEqual(run.stats.counts[MID]!)
    // Entity bindings exist for near characters only.
    const bindings = c.world.resource(AnimationStateResource).bindings
    for (const e of behind) expect(bindings.has(e)).toBe(false)
    expect(bindings.size).toBeLessThanOrEqual(run.stats.counts[NEAR]!)
    // Turn around in one frame: everything behind is drawn now.
    c.world.set(c.camera, Transform, { translation: [0, 1.5, 0], rotation: [0, 1, 0, 0] })
    c.app.update(1 / 60)
    for (const e of behind) {
      const st = states.get(e)!
      expect(st.tier).not.toBe(OFF)
      const torso = st.parts.find((p) => c.world.get(p, CharacterPart).name === 'body-torso')!
      if (st.tier !== FAR) expect(c.world.get(torso, ComputedVisibility).visible).toBe(true)
    }
    for (const e of ahead) expect(states.get(e)!.tier).toBe(OFF)
  })

  it('ticks game AI on a stagger by sim tier', { timeout: timeout(120_000) }, async () => {
    if (!gpu) return
    const c = await start()
    const far: Entity[] = []
    for (let k = 0; k < 60; k++) far.push(zombie(c, 200 + k))
    const ticks = new Map<Entity, number>()
    let worstFrame = 0
    for (let f = 0; f < 60; f++) {
      c.app.update(1 / 60)
      let frame = 0
      for (const e of far) {
        if (c.world.get(e, CharacterTier).simTick) {
          ticks.set(e, (ticks.get(e) ?? 0) + 1)
          frame++
        }
      }
      worstFrame = Math.max(worstFrame, frame)
    }
    for (const e of far) {
      expect(c.world.get(e, CharacterTier).sim).toBe('far')
      expect(ticks.get(e)).toBe(4)
    }
    expect(worstFrame).toBeLessThanOrEqual(Math.ceil(60 / 15) + 1)
  })
})
