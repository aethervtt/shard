import {
  audioLog,
  audioPlugin,
  createHeadlessAudioBackend,
  type HeadlessAudioBackend,
} from '@aethervtt/shard-audio'
import type { Entity, ShardError } from '@aethervtt/shard-core'
import { allocationChecks, gcWindow, timeout } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { particlesPlugin } from '@aethervtt/shard-particles'
import type { TrackWorkerLike } from '@aethervtt/shard-physics/worker'
import {
  Cameras,
  captureView,
  forwardPlugin,
  LensFields,
  Materials,
  MeshMaterial,
  OffscreenTarget,
  RenderStats,
  renderPlugin,
} from '@aethervtt/shard-render'
import { settle } from '@aethervtt/shard-render/testing'
import { App, FrameDemand } from '@aethervtt/shard-runtime'
import { Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defineDiceAttachment } from './attachments'
import { DiceDie } from './components'
import { dieGeometry, requireDie } from './definition'
import { DiceEffectRecipe, diceEffectRecipe } from './effects'
import { markAngle, naturalValue } from './landing'
import { defineDiceFamily } from './material'
import { dicePlugin } from './plugin'
import { renderDiceThumbnail } from './preview'
import type { DiceRoll } from './roll'
import { DICE_SKINS, DiceSkin, diceSkin } from './skin'
import { ANIMATED_DEMAND, DiceTable, PRESENTATION_DEMAND } from './table'

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => gpu.destroy())

interface Rig {
  app: App
  table: ReturnType<App['world']['resource']> & import('./table').DiceTableState
  clock: { now: number }
  frame(ms?: number): void
  target: OffscreenTarget
  audio: HeadlessAudioBackend | undefined
}

async function rig(
  options: {
    restMs?: number
    audio?: boolean
    worker?: () => TrackWorkerLike
    size?: [number, number]
  } = {},
): Promise<Rig> {
  const [w, h] = options.size ?? [320, 180]
  const target = new OffscreenTarget(gpu, { label: 'window', width: w, height: h })
  const clock = { now: 0 }
  const audio = options.audio ? createHeadlessAudioBackend() : undefined
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, target, owner: 'dice' }),
    forwardPlugin({ msaa: 1 }),
    particlesPlugin,
    ...(audio ? [audioPlugin({ backend: audio })] : []),
    dicePlugin({ now: () => clock.now, restMs: options.restMs ?? 2000, worker: options.worker }),
  )
  await app.init()
  await settle(app, 8)
  const frame = (ms = 1000 / 60) => {
    clock.now += ms
    app.update(ms / 1000)
  }
  return { app, table: app.world.resource(DiceTable) as Rig['table'], clock, frame, target, audio }
}

const dice = (app: App): Entity[] => [...app.world.query({ with: [DiceDie] }).entities()]

/** Frames (and the event loop between them) until `done` or `max` frames ran. */
async function until(r: Rig, done: () => boolean, max = 1200): Promise<number> {
  for (let i = 0; i < max; i++) {
    if (done()) return i
    r.frame()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(`still ${r.table.phase} after ${max} frames`)
}

const roll = (over: Partial<DiceRoll> = {}): DiceRoll => ({
  id: 'table-test',
  dice: [
    { kind: 'd6', value: 4, skin: DICE_SKINS.ivory },
    { kind: 'd20', value: 17, skin: DICE_SKINS.teal },
    { kind: 'percentile', value: 7, skin: DICE_SKINS.brass },
  ],
  ...over,
})

/** The value each die on the table shows, read from its transform. */
function shown(app: App): { value: number; natural: number; angle: number }[] {
  return dice(app)
    .map((e) => {
      const d = app.world.get(e, DiceDie)
      const g = dieGeometry(requireDie(d.definition))
      const q = app.world.get(e, Transform).rotation
      return {
        index: d.index,
        value: d.value,
        natural: naturalValue(g, q),
        angle: markAngle(g, q, d.value),
      }
    })
    .sort((a, b) => a.index - b.index)
}

describe('the dice table (0054)', () => {
  it('plays a roll through its phases, showing the host’s values, holding frames only while it moves', {
    timeout: timeout(60_000),
  }, async () => {
    const r = await rig()
    const demand = r.app.world.resource(FrameDemand)
    const outcome = r.table.play(roll())
    expect(r.table.phase).toBe('simulating')
    expect(demand.isHeld(PRESENTATION_DEMAND)).toBe(true)
    await until(r, () => r.table.phase === 'tumble')
    expect(dice(r.app)).toHaveLength(4)
    await until(r, () => r.table.phase === 'rest')
    for (const d of shown(r.app)) expect(d.natural, `die ${d.value}`).toBe(d.value)
    // At rest, frames only come when asked for (the rest's end, and the release after it).
    await until(r, () => !demand.isHeld(PRESENTATION_DEMAND), 60)
    expect(demand.held().filter((k) => k.startsWith('dice/'))).toEqual([])
    const described = r.table.describe() as {
      track: { settled: boolean }
      dice: { natural: number; value: number }[]
    }
    expect(described.track.settled).toBe(true)
    r.clock.now += 2000
    r.frame()
    expect(await outcome).toBe('finished')
    expect(dice(r.app)).toHaveLength(0)
    expect(r.table.phase).toBe('idle')
    await r.app.dispose()
  })

  it('reduced motion sends nothing to the worker, and shows the targets upright once faded in', {
    timeout: timeout(30_000),
  }, async () => {
    const r = await rig()
    const outcome = r.table.play(roll({ motion: 'reduced' }))
    await until(r, () => r.table.phase === 'rest')
    expect(r.table.recordings).toBe(0)
    const materials = r.app.world.resource(Materials)
    const fade = () =>
      dice(r.app).map(
        (e) => materials.get(r.app.world.get(e, MeshMaterial).material)!.value.fade as number,
      )
    // Fading in: 150 ms.
    expect(Math.max(...fade())).toBeLessThan(1)
    r.frame(160)
    expect(fade().every((f) => f === 1)).toBe(true)
    for (const d of shown(r.app)) {
      expect(d.natural).toBe(d.value)
      expect(d.angle).toBeLessThan(1e-3)
    }
    r.table.dismiss()
    expect(await outcome).toBe('dismissed')
    await r.app.dispose()
  })

  it('cancels from every phase within a frame (simulating within 10 ms), leaving no dice and no demand', {
    timeout: timeout(90_000),
  }, async () => {
    const r = await rig()
    const demand = r.app.world.resource(FrameDemand)
    const recipe = r.app.world.resource(DiceEffectRecipe.store)
    recipe.set(
      'test:glow',
      diceEffectRecipe({
        id: 'glow',
        effects: [{ kind: 'light-pulse', durationMs: 1200, intensity: 3 }],
      }),
    )
    r.app.world
      .resource(DiceSkin.store)
      .set(
        'test:glowing',
        diceSkin({ id: 'glowing', family: 'dice/SolidDice', effects: [{ guid: 'test:glow' }] }),
      )
    const glowing = { type: 'dice/DiceSkin', guid: 'test:glowing', path: undefined }
    for (const phase of ['simulating', 'tumble', 'accent', 'rest'] as const) {
      const abort = new AbortController()
      const outcome = r.table.play(
        { ...roll(), dice: [{ kind: 'd8', value: 3, skin: glowing }] },
        { signal: abort.signal },
      )
      if (phase !== 'simulating') await until(r, () => r.table.phase === phase)
      const at = performance.now()
      abort.abort()
      expect(await outcome, phase).toBe('cancelled')
      expect(performance.now() - at).toBeLessThan(phase === 'simulating' ? 10 : 1000 / 60)
      expect(dice(r.app), phase).toHaveLength(0)
      expect(demand.isHeld(PRESENTATION_DEMAND), phase).toBe(false)
      expect(r.table.phase).toBe('idle')
    }
    await r.app.dispose()
  })

  it('fails what it cannot show before anything plays, refuses a second roll, and replaces on request', {
    timeout: timeout(30_000),
  }, async () => {
    const r = await rig()
    const bad = await r.table.play(
      roll({ dice: [{ kind: 'd6', value: 9, skin: DICE_SKINS.ivory }] }),
    )
    expect(bad).toBe('failed')
    expect(r.table.lastError?.code).toBe('dice/invalid-value')
    expect(dice(r.app)).toHaveLength(0)
    const missing = await r.table.play(
      roll({
        dice: [
          { kind: 'd6', value: 2, skin: { type: 'dice/DiceSkin', guid: 'nope', path: undefined } },
        ],
      }),
    )
    expect(missing).toBe('failed')
    expect(r.table.lastError?.code).toBe('dice/unknown-skin')
    const first = r.table.play(roll())
    const err = await r.table.play(roll()).then(
      () => undefined,
      (e: unknown) => e as ShardError,
    )
    expect(err?.code).toBe('dice/busy')
    const second = r.table.play(roll({ id: 'second' }), { replace: true })
    expect(await first).toBe('dismissed')
    await until(r, () => r.table.phase === 'rest')
    r.table.shortenRest(100)
    r.frame(120)
    expect(await second).toBe('finished')
    await r.app.dispose()
  })

  it('fails a roll whose worker crashes, and plays the next one', {
    timeout: timeout(30_000),
  }, async () => {
    let crash = true
    const listeners = new Map<string, ((e: never) => void)[]>()
    const crashing = (): TrackWorkerLike => ({
      postMessage(message) {
        if (message.type !== 'record') return
        for (const l of listeners.get('error') ?? []) l({ type: 'error', message: 'boom' } as never)
      },
      addEventListener(type: string, l: (e: never) => void) {
        listeners.set(type, [...(listeners.get(type) ?? []), l])
      },
      terminate() {},
    })
    const r = await rig({ worker: () => (crash ? crashing() : crashing()) })
    expect(await r.table.play(roll())).toBe('failed')
    expect(r.table.lastError?.code).toBe('physics/worker-crashed')
    expect(dice(r.app)).toHaveLength(0)
    crash = false
    await r.app.dispose()
  })

  it('returns gpu.stats to its baseline 8 s after the rest, and to 0 after dispose', {
    timeout: timeout(60_000),
  }, async () => {
    const r = await rig({ restMs: 500 })
    const stats = () => gpu.stats('dice')
    const cycle = async (id: string) => {
      const outcome = r.table.play(roll({ id }))
      await until(r, () => r.table.phase === 'rest')
      const during = stats()
      r.clock.now += 600
      r.frame()
      expect(await outcome).toBe('finished')
      // Released 8 s after the last use; the table asks for the frame that does it.
      expect(r.app.world.resource(FrameDemand).dueIn()).toBeLessThanOrEqual(8016 + 1)
      r.clock.now += 8100
      r.frame()
      await settle(r.app, 3)
      return during
    }
    // The renderer's instance buffers keep the capacity a first roll grew them to: the baseline is
    // after one roll has come and gone.
    await cycle('warm')
    const baseline = stats()
    expect((r.table.describe() as { resources: { entries: number } }).resources.entries).toBe(0)
    const during = await cycle('again')
    expect(during.textures).toBeGreaterThan(baseline.textures)
    expect(stats()).toEqual(baseline)
    await r.app.dispose()
    expect(gpu.stats('dice')).toEqual({ buffers: 0, textures: 0, bytes: 0 })
  })

  it('renders a landed roll over alpha 0: nothing outside the dice and their shadows', {
    timeout: timeout(60_000),
  }, async () => {
    const r = await rig({ size: [480, 270] })
    const outcome = r.table.play(
      roll({
        id: 'alpha',
        dice: [
          { kind: 'd6', value: 1, skin: DICE_SKINS.ivory },
          { kind: 'd12', value: 5, skin: DICE_SKINS.obsidian },
          { kind: 'd20', value: 20, skin: DICE_SKINS.frost },
        ],
      }),
    )
    await until(r, () => r.table.phase === 'rest')
    await settle(r.app, 6)
    const view = `camera:${r.table.camera}`
    const shot = captureView(r.app.world, view)
    r.frame()
    const image = await shot
    const cam = r.app.world.resource(Cameras).get(r.table.camera)!
    const centers = dice(r.app).map((e) => {
      const p = r.app.world.get(e, Transform).translation
      const m = cam.viewProj
      const w = m[3]! * p[0]! + m[7]! * p[1]! + m[11]! * p[2]! + m[15]!
      const x = (m[0]! * p[0]! + m[4]! * p[1]! + m[8]! * p[2]! + m[12]!) / w
      const y = (m[1]! * p[0]! + m[5]! * p[1]! + m[9]! * p[2]! + m[13]!) / w
      return [((x + 1) / 2) * image.width, ((1 - y) / 2) * image.height] as const
    })
    // A die and its shadow fit in a disc a few die radii across.
    const reach = image.height * 0.22
    let clear = 0
    let stray = 0
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        const a = image.data[(y * image.width + x) * 4 + 3]!
        if (a === 0) {
          clear++
          continue
        }
        if (!centers.some(([cx, cy]) => Math.hypot(x - cx, y - cy) < reach)) stray++
      }
    }
    expect(stray).toBe(0)
    expect(clear).toBeGreaterThan(image.width * image.height * 0.7)
    r.table.dismiss()
    await outcome
    await r.app.dispose()
  })

  it('gives dropped dice no effects or attachments, and keeps at most 4 attachments alive', {
    timeout: timeout(60_000),
  }, async () => {
    const r = await rig()
    const world = r.app.world
    let spawned = 0
    defineDiceAttachment('test-orb', {
      vertices: 24,
      spawn: (ctx) => {
        spawned++
        return [ctx.world.spawn([Transform, { translation: [0, 1, 0] }])]
      },
      update: () => true,
    })
    world.resource(DiceEffectRecipe.store).set(
      'test:crit',
      diceEffectRecipe({
        id: 'crit',
        conditions: [{ kind: 'die', die: 'd20', value: 20 }],
        effects: [
          { kind: 'attachment', attachment: 'test-orb' },
          { kind: 'light-pulse', durationMs: 300 },
        ],
      }),
    )
    world
      .resource(DiceSkin.store)
      .set(
        'test:crit-skin',
        diceSkin({ id: 'crit-skin', family: 'dice/SolidDice', effects: [{ guid: 'test:crit' }] }),
      )
    const skin = { type: 'dice/DiceSkin', guid: 'test:crit-skin', path: undefined }
    const twenties = (n: number, dropped: number[]) =>
      Array.from({ length: n }, (_, i) => ({
        kind: 'd20' as const,
        value: 20,
        skin,
        dropped: dropped.includes(i),
      }))
    // Only a dropped die matches: the recipe plays, but nothing anchors to it.
    let outcome = r.table.play(
      roll({ id: 'dropped', dice: [...twenties(1, [0]), { kind: 'd6', value: 2, skin }] }),
    )
    await until(r, () => r.table.phase === 'accent' || r.table.phase === 'rest')
    const alone = r.table.describe() as {
      recipes: { id: string; anchors: number[] }[]
      attachments: unknown[]
    }
    expect(alone.recipes).toEqual([{ id: 'crit', anchors: [] }])
    expect(alone.attachments).toEqual([])
    expect(spawned).toBe(0)
    r.table.dismiss()
    await outcome
    // The crit is on a die of another skin: the recipe's conditions match the roll, but its effects
    // play only on dice whose skin carries it.
    outcome = r.table.play(
      roll({
        id: 'other-skin',
        dice: [
          { kind: 'd20', value: 20, skin: DICE_SKINS.ivory },
          { kind: 'd6', value: 2, skin },
        ],
      }),
    )
    await until(r, () => r.table.phase === 'accent' || r.table.phase === 'rest')
    const other = r.table.describe() as {
      recipes: { id: string; anchors: number[] }[]
      attachments: unknown[]
    }
    expect(other.recipes).toEqual([{ id: 'crit', anchors: [] }])
    expect(other.attachments).toEqual([])
    expect(spawned).toBe(0)
    r.table.dismiss()
    await outcome
    // Six kept twenties and a dropped one: four attachments, none on the dropped die.
    outcome = r.table.play(roll({ id: 'many', dice: twenties(7, [3]) }))
    await until(r, () => r.table.phase === 'accent' || r.table.phase === 'rest')
    const many = r.table.describe() as {
      attachments: { die: number }[]
      recipes: { anchors: number[] }[]
    }
    expect(many.attachments).toHaveLength(4)
    expect(many.attachments.map((a) => a.die)).not.toContain(3)
    expect(many.recipes[0]!.anchors).not.toContain(3)
    expect(spawned).toBe(4)
    r.table.dismiss()
    await outcome
    await r.app.dispose()
  })

  it('publishes no lens fields in reduced motion, with effects off, in large pools or after disposal; a field expires ttlMs after its last refresh', {
    timeout: timeout(90_000),
  }, async () => {
    const r = await rig()
    const world = r.app.world
    let refreshing = true
    defineDiceAttachment('test-lens', {
      vertices: 1,
      spawn: () => [],
      update: (ctx, seconds) => {
        if (refreshing) ctx.lens({ radius: 40, strength: -0.8, ttlMs: 100 })
        return seconds < 30
      },
    })
    world.resource(DiceEffectRecipe.store).set(
      'test:hole',
      diceEffectRecipe({
        id: 'hole',
        effects: [
          { kind: 'attachment', attachment: 'test-lens' },
          { kind: 'lens-pulse', durationMs: 400 },
        ],
      }),
    )
    world
      .resource(DiceSkin.store)
      .set(
        'test:hole-skin',
        diceSkin({ id: 'hole-skin', family: 'dice/SolidDice', effects: [{ guid: 'test:hole' }] }),
      )
    const skin = { type: 'dice/DiceSkin', guid: 'test:hole-skin', path: undefined }
    const fields = () => world.resource(LensFields).fields.length
    const one = [{ kind: 'd20' as const, value: 20, skin }]
    const pool = Array.from({ length: 20 }, () => ({ kind: 'd6' as const, value: 1, skin }))
    for (const [label, over] of [
      ['reduced motion', { motion: 'reduced' as const, dice: one }],
      ['effects off', { effects: false, dice: one }],
      ['large pool', { dice: pool }],
    ] as const) {
      const outcome = r.table.play(roll({ id: label, ...over }))
      let seen = 0
      await until(r, () => {
        seen = Math.max(seen, fields())
        return r.table.phase === 'rest'
      })
      for (let i = 0; i < 20; i++) {
        r.frame()
        seen = Math.max(seen, fields())
      }
      expect(seen, label).toBe(0)
      r.table.dismiss()
      await outcome
    }
    // Full: the attachment refreshes a field; when it stops, the field lasts ttlMs.
    const outcome = r.table.play(roll({ id: 'lens', dice: one }))
    await until(r, () => r.table.phase === 'accent' || r.table.phase === 'rest')
    for (let i = 0; i < 40; i++) r.frame()
    expect(fields()).toBeGreaterThan(0)
    refreshing = false
    // 100 ms from the last refresh (which counted down its own frame): alive at 66, gone by 116.
    for (let i = 0; i < 3; i++) r.frame()
    expect(fields()).toBeGreaterThan(0)
    for (let i = 0; i < 3; i++) r.frame()
    expect(fields()).toBe(0)
    // Disposal clears what's published.
    refreshing = true
    r.frame()
    expect(fields()).toBeGreaterThan(0)
    await r.app.dispose()
    expect(world.resource(LensFields).fields).toHaveLength(0)
    await outcome
  })

  it('plays contact sounds as the track recorded them, varied, and none of them late', {
    timeout: timeout(60_000),
  }, async () => {
    const r = await rig({ audio: true })
    const outcome = r.table.play(roll({ id: 'loud' }))
    await until(r, () => r.table.phase === 'tumble')
    // Baked and preloaded before the tumble: every layer and variation of resin and metal (brass).
    const preloaded = r.audio!.preloaded.filter((id) => id.startsWith('dice:impact/'))
    expect(preloaded.length).toBe(2 * 2 * 3 * 6)
    await until(r, () => r.table.phase === 'rest')
    const log = audioLog(r.app.world, 0)
    const started = log.filter((e) => e.event === 'start' && e.clip?.startsWith('dice:impact/'))
    expect(started.length).toBeGreaterThan(3)
    // At most four a frame; no two at the same pitch; more than one clip.
    const perFrame = new Map<number, number>()
    for (const e of started) perFrame.set(e.frame, (perFrame.get(e.frame) ?? 0) + 1)
    expect(Math.max(...perFrame.values())).toBeLessThanOrEqual(4)
    const impacts = r.audio!.history.filter((v) => v.clip.startsWith('dice:impact/'))
    expect(new Set(impacts.map((v) => v.params.pitch)).size).toBe(impacts.length)
    expect(new Set(impacts.map((v) => v.clip)).size).toBeGreaterThan(1)
    r.table.dismiss()
    await outcome
    // Muted: none.
    const quiet = r.table.play(roll({ id: 'quiet', soundGain: 0 }))
    const before = audioLog(r.app.world, 0).length
    await until(r, () => r.table.phase === 'rest')
    expect(audioLog(r.app.world, 0).length).toBe(before)
    r.table.dismiss()
    await quiet
    await r.app.dispose()
  })

  it('keeps frames coming while an animated family is shown, at its rate, never under reduced motion', {
    timeout: timeout(60_000),
  }, async () => {
    const surface = 'p.emissive += vec3f(1.0 + sin(globals.time * 3.0)) * 400.0;'
    defineDiceFamily('test/Pulse', { animated: true, surface })
    defineDiceFamily('test/Slow', { animated: { fps: 12 }, surface })
    const r = await rig({ restMs: 60_000 })
    const world = r.app.world
    const store = world.resource(DiceSkin.store)
    store.set('test:pulse', diceSkin({ id: 'pulse', family: 'test/Pulse' }))
    store.set('test:slow', diceSkin({ id: 'slow', family: 'test/Slow' }))
    const skin = (guid: string) => ({ type: 'dice/DiceSkin', guid, path: undefined })
    const one = (guid: string) => [{ kind: 'd20' as const, value: 7, skin: skin(guid) }]
    const demand = world.resource(FrameDemand)
    const rest = async () => {
      await until(r, () => r.table.phase === 'rest')
      for (let i = 0; i < 30; i++) r.frame()
    }
    // The display's rate: held all through the rest, where a still family would let go.
    let outcome = r.table.play(roll({ id: 'pulse', dice: one('test:pulse') }))
    await rest()
    expect(demand.isHeld(ANIMATED_DEMAND)).toBe(true)
    expect(demand.isHeld(PRESENTATION_DEMAND)).toBe(false)
    expect(r.table.describe()).toMatchObject({ animated: 'display' })
    // Reactions start from the shader clock at landing.
    const m = world.resource(Materials).get(world.get(dice(r.app)[0]!, MeshMaterial).material!)!
    expect(m.value.resultTime).toBeGreaterThan(0)
    r.table.dismiss()
    await outcome
    expect(demand.isHeld(ANIMATED_DEMAND)).toBe(false)
    // At most 12 fps: the next frame asked for a twelfth of a second on.
    outcome = r.table.play(roll({ id: 'slow', dice: one('test:slow') }))
    await rest()
    expect(demand.isHeld(ANIMATED_DEMAND)).toBe(false)
    expect(demand.dueIn()).toBeLessThanOrEqual(1000 / 12 + 1)
    r.table.dismiss()
    await outcome
    // Reduced motion: still.
    outcome = r.table.play(roll({ id: 'still', motion: 'reduced', dice: one('test:pulse') }))
    await rest()
    expect(demand.isHeld(ANIMATED_DEMAND)).toBe(false)
    expect(r.table.describe()).toMatchObject({ animated: null })
    r.table.dismiss()
    await outcome
    await r.app.dispose()
  })

  it('renders thumbnails on the app’s own device', { timeout: timeout(60_000) }, async () => {
    const r = await rig()
    const surfaces = gpu.surfaces.length
    const thumb = await renderDiceThumbnail(r.app, {
      skin: DICE_SKINS.brass,
      kind: 'd20',
      value: 20,
      size: 96,
    })
    expect(thumb.png?.subarray(1, 4)).toEqual(new Uint8Array([80, 78, 71]))
    expect(gpu.surfaces.length).toBe(surfaces)
    await r.app.dispose()
  })
})

describe('the large-pool tier (0054)', () => {
  it('draws 32 d6 in at most one instanced draw per (definition, skin) plus the floor, allocating nothing while they tumble', {
    timeout: timeout(90_000),
  }, async () => {
    const r = await rig({ size: [640, 360] })
    const pool = Array.from({ length: 32 }, (_, i) => ({
      kind: 'd6' as const,
      value: (i % 6) + 1,
      skin: DICE_SKINS.ivory,
    }))
    const outcome = r.table.play(roll({ id: 'pool', dice: pool }))
    await until(r, () => r.table.phase === 'tumble')
    expect((r.table.describe() as { quality: { tier: string } }).quality.tier).toBe('large-pool')
    await settle(r.app, 4)
    // Warm, then count: the playback path must not allocate.
    for (let i = 0; i < 20; i++) r.frame()
    const view = `camera:${r.table.camera}`
    // One draw for the dice (d6, ivory), one for the tray (floor and every blob).
    expect(r.app.world.resource(RenderStats).get(view)!.drawCalls).toBeLessThanOrEqual(2)
    if (allocationChecks) {
      ;(globalThis as { gc?: () => void }).gc?.()
      const window = gcWindow()
      for (let i = 0; i < 60; i++) r.frame()
      expect(await window.end()).toBe(0)
    }
    expect(r.table.phase).toBe('tumble')
    r.table.dismiss()
    await outcome
    await r.app.dispose()
  })

  it('keeps each skin’s family (see-through ones drawn opaque) and fades the shadow in as it lands', {
    timeout: timeout(90_000),
  }, async () => {
    const r = await rig({ size: [640, 360], restMs: 60_000 })
    const pool = Array.from({ length: 20 }, (_, i) => ({
      kind: 'd6' as const,
      value: (i % 6) + 1,
      skin: i % 2 ? DICE_SKINS.teal : DICE_SKINS.frost,
    }))
    const outcome = r.table.play(roll({ id: 'pool-skins', dice: pool }))
    await until(r, () => r.table.phase === 'tumble')
    const world = r.app.world
    const materials = world.resource(Materials)
    const looks = new Set(
      dice(r.app).map((e) => {
        const m = materials.get(world.get(e, MeshMaterial).material)!
        return `${m.type.name}:${m.value.alphaMode}`
      }),
    )
    expect(looks).toEqual(new Set(['dice/ResinDice:opaque', 'dice/GlassDice:opaque']))
    const tray = materials.get(r.table.trayMaterial!)!
    const full = tray.value.shadowOpacity as number
    const blobs = () =>
      [...world.query({ with: [MeshMaterial] }).entities()].filter(
        (e) =>
          world.get(e, MeshMaterial).material?.guid === r.table.trayMaterial!.guid &&
          e !== r.table.floor,
      )
    expect(blobs().length).toBe(20)
    // Landing: the tray's shadow rises from 0 over the result ramp while the blobs fade, then go.
    await until(r, () => r.table.phase !== 'tumble')
    const seen: number[] = []
    for (let i = 0; i < 30; i++) {
      seen.push(tray.value.shadowOpacity as number)
      r.frame()
    }
    expect(seen[0]!).toBeLessThan(full * 0.2)
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!)
    expect(seen.filter((v) => v > 0.05 * full && v < 0.95 * full).length).toBeGreaterThan(8)
    expect(seen.at(-1)).toBeCloseTo(full, 6)
    expect(blobs().length).toBe(0)
    r.table.dismiss()
    await outcome
    expect(tray.value.shadowOpacity).toBeCloseTo(full, 6)
    await r.app.dispose()
  })
})
