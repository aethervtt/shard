import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { Rng, type ShardError } from '@aethervtt/shard-core'
import { timeout } from '@aethervtt/shard-core/test-env'
import { recordTrack, sceneHash, type Track, trackHash } from '@aethervtt/shard-physics/track'
import {
  createTrackClient,
  type TrackClient,
  type TrackWorkerLike,
} from '@aethervtt/shard-physics/worker'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { DIE_KINDS, registerBuiltinDice } from './builtins'
import { dieGeometry, requireDie } from './definition'
import golden from './golden.json'
import { restRotation } from './landing'
import { type DiceRoll, expandRoll, rollTrackRequest } from './roll'
import { DICE_SETTLE_RULE, diceSettle, outsideTray, restingFlat } from './settle'
import {
  DICE_CONTACTS,
  DICE_MAX_STEPS,
  diceSettleParams,
  diceTrackScene,
  placeDie,
  placementSpots,
  unlandedDice,
} from './track'

beforeAll(() => registerBuiltinDice())

const skin = { type: 'dice/DiceSkin', guid: 'dice:ivory', path: undefined }
const tray = { halfWidth: 5.4, halfDepth: 3.15 }

function request(roll: DiceRoll) {
  return rollTrackRequest(roll, expandRoll(roll), roll.tray ?? tray)
}

async function record(roll: DiceRoll): Promise<Track> {
  const r = request(roll)
  return recordTrack(diceTrackScene(r), {
    settle: diceSettle(diceSettleParams(r)),
    contacts: DICE_CONTACTS,
  })
}

const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href

/** `test-worker.ts` on worker_threads, through the web Worker interface the client expects. */
function nodeWorker(): TrackWorkerLike {
  const worker = new Worker(new URL('./test-worker.ts', import.meta.url), {
    execArgv: ['--import', tsx],
  })
  const listeners: Record<string, ((event: never) => void)[]> = {
    message: [],
    error: [],
    messageerror: [],
  }
  const emit = (type: string, event: unknown) => {
    for (const listener of listeners[type]!) listener(event as never)
  }
  worker.on('message', (data) => emit('message', { data }))
  worker.on('error', (err: Error) => emit('error', { type: 'error', message: err.message }))
  return {
    postMessage: (message, transfer) => worker.postMessage(message, transfer as ArrayBuffer[]),
    addEventListener: (type: string, listener: (event: never) => void) =>
      void listeners[type]!.push(listener),
    terminate: () => void worker.terminate(),
  }
}

const clients: TrackClient[] = []
afterEach(() => {
  for (const c of clients.splice(0)) c.dispose()
})

const hex = (h: number) => h.toString(16).padStart(8, '0')
const goldenRoll = () =>
  ({ ...golden.roll, dice: golden.roll.dice.map((d) => ({ ...d, skin })) }) as DiceRoll

describe('dice tracks', () => {
  it('records the same track for a roll inline and in a worker, and it is the golden one', {
    timeout: timeout(60_000),
  }, async () => {
    const hashes: string[] = []
    for (const spawn of ['inline', nodeWorker] as const) {
      const client = createTrackClient({
        spawn,
        rules: { [DICE_SETTLE_RULE]: diceSettle },
      })
      clients.push(client)
      const r = request(goldenRoll())
      const track = await client.record(diceTrackScene(r), {
        settle: { rule: DICE_SETTLE_RULE, params: diceSettleParams(r) },
        contacts: DICE_CONTACTS,
      })
      hashes.push(hex(trackHash(track)))
    }
    expect(hashes).toEqual([golden.hash, golden.hash])
  })

  it('records the same track whatever the values are', async () => {
    const roll = goldenRoll()
    const other: DiceRoll = {
      ...roll,
      dice: roll.dice.map((d) => ({
        ...d,
        value: d.kind === 'percentile' || d.kind === 'd100' ? 100 : 1,
      })),
    }
    expect(sceneHash(diceTrackScene(request(other)))).toBe(sceneHash(diceTrackScene(request(roll))))
    expect(trackHash(await record(other))).toBe(trackHash(await record(roll)))
    // The seed and the tray are inputs.
    expect(sceneHash(diceTrackScene(request({ ...roll, seed: 'another' })))).not.toBe(
      sceneHash(diceTrackScene(request(roll))),
    )
    expect(
      sceneHash(diceTrackScene(request({ ...roll, tray: { halfWidth: 4, halfDepth: 3 } }))),
    ).not.toBe(sceneHash(diceTrackScene(request(roll))))
  })

  it('settles 32 mixed dice, or places them, within 480 steps for 200 seeds: none outside, none cocked', {
    timeout: timeout(180_000),
  }, async () => {
    const kinds = DIE_KINDS.filter((k) => k !== 'percentile')
    let placed = 0
    let settled = 0
    for (let seed = 0; seed < 200; seed++) {
      const rng = new Rng(seed)
      const dice = Array.from({ length: 32 }, () => {
        const kind = rng.pick(kinds)
        return { kind, value: 1, skin, dropped: rng.bool(0.2) }
      })
      const roll: DiceRoll = { id: `sweep-${seed}`, dice }
      const bodies = expandRoll(roll)
      const r = rollTrackRequest(roll, bodies, tray)
      const track = await recordTrack(diceTrackScene(r), {
        settle: diceSettle(diceSettleParams(r)),
      })
      expect(track.steps).toBeLessThanOrEqual(DICE_MAX_STEPS)
      if (track.settled) settled++
      const unlanded = unlandedDice(track, r)
      const spots = placementSpots(track, r, unlanded)
      unlanded.forEach((reason, i) => {
        if (!reason) return
        placed++
        const g = dieGeometry(requireDie(r.dice[i]!.definition))
        placeDie(track, i, spots[i]!, restRotation(g, 1), g, r.dice[i]!.scale)
      })
      const params = diceSettleParams(r)
      const o = track.steps * track.bodyCount
      for (let i = 0; i < track.bodyCount; i++) {
        const p = track.positions.subarray((o + i) * 3, (o + i) * 3 + 3)
        const q = track.rotations.subarray((o + i) * 4, (o + i) * 4 + 4)
        expect(outsideTray(p, tray), `seed ${seed} die ${i}`).toBe(false)
        expect(restingFlat(params.bodies[i]!, p, q), `seed ${seed} die ${i}`).toBe(true)
      }
    }
    // Nearly every throw settles by itself; the fallback is for the rest.
    expect(settled).toBeGreaterThan(190)
    expect(placed).toBeLessThan(200)
  })

  it('places a die that left the tray, and one left cocked, into free spots', async () => {
    const roll: DiceRoll = {
      id: 'placed',
      dice: [
        { kind: 'd6', value: 3, skin },
        { kind: 'd20', value: 17, skin },
        { kind: 'd8', value: 5, skin },
      ],
    }
    const bodies = expandRoll(roll)
    const r = rollTrackRequest(roll, bodies, tray)
    const track = await record(roll)
    const o = track.steps * track.bodyCount
    // Die 1 fell off the table; die 2 is balanced on an edge.
    track.positions.set([30, -40, 2], (o + 1) * 3)
    track.rotations.set([Math.sin(Math.PI / 8), 0, 0, Math.cos(Math.PI / 8)], (o + 2) * 4)
    const unlanded = unlandedDice(track, r)
    expect(unlanded).toEqual([null, 'outside', 'cocked'])
    const spots = placementSpots(track, r, unlanded)
    expect(spots[0]).toBeNull()
    const d0 = [track.positions[o * 3]!, track.positions[o * 3 + 2]!]
    for (const i of [1, 2]) {
      const spot = spots[i]!
      const g = dieGeometry(requireDie(r.dice[i]!.definition))
      placeDie(track, i, spot, restRotation(g, bodies[i]!.value), g, r.dice[i]!.scale)
      // Away from the die that landed, and inside the tray.
      expect(Math.hypot(spot[0] - d0[0]!, spot[2] - d0[1]!)).toBeGreaterThan(0.5)
      expect(outsideTray(spot, tray)).toBe(false)
      // It drops straight down: x and z hold over the drop, y only falls.
      const n = track.bodyCount
      let lastY = Number.POSITIVE_INFINITY
      for (let s = track.steps - 20; s <= track.steps; s++) {
        expect(track.positions[(s * n + i) * 3]).toBeCloseTo(spot[0], 5)
        const y = track.positions[(s * n + i) * 3 + 1]!
        expect(y).toBeLessThanOrEqual(lastY)
        lastY = y
      }
    }
    expect(spots[1]).not.toEqual(spots[2])
    const params = diceSettleParams(r)
    for (let i = 0; i < 3; i++) {
      const p = track.positions.subarray((o + i) * 3, (o + i) * 3 + 3)
      const q = track.rotations.subarray((o + i) * 4, (o + i) * 4 + 4)
      expect(restingFlat(params.bodies[i]!, p, q)).toBe(true)
    }
  })

  it('fails a value a die cannot show before anything records', () => {
    for (const [kind, value] of [
      ['d6', 7],
      ['d20', 0],
      ['percentile', 101],
      ['d4', 2.5],
    ] as const) {
      let err: ShardError | undefined
      try {
        expandRoll({ id: 'bad', dice: [{ kind, value, skin }] })
      } catch (e) {
        err = e as ShardError
      }
      expect(err?.code, `${kind} ${value}`).toBe('dice/invalid-value')
      expect(err?.path).toBe('dice[0].value')
    }
  })
})
