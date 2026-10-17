import { t, World } from '@aethervtt/shard-core'
import { budget, timingMode } from '@aethervtt/shard-core/test-env'
import { defineMaterial, Materials, Meshes } from '@aethervtt/shard-render'
import { Textures } from '@aethervtt/shard-texture'
import { afterEach, describe, expect, it } from 'vitest'
import { CardCollection, cardPose } from './collection'
import { CardDefinition, cardDefinition } from './definition'
import { builtinCardFinishes } from './finishes'
import { cardMesh } from './mesh'
import { sampleCardMotion } from './motion'
import { CardTableState, cardTiltCoordinates, createCardHit, hitCards } from './table'
import { prepareCardTextures } from './textures'

const tables: CardTableState[] = []
function table(capacity = 1024) {
  const world = new World()
  world.initResource(Materials)
  world.initResource(Meshes)
  world.initResource(Textures)
  world.initResource(CardDefinition.store)
  const page = prepareCardTextures([], { width: 2, height: 2 })
  const type = defineMaterial('cards-test/Headless', {
    extends: 'none',
    fields: { art: t.handle('Texture'), masks: t.handle('Texture'), records: t.handle('Texture') },
  })
  const value = new CardTableState(world, builtinCardFinishes(), type, page, page, capacity)
  tables.push(value)
  return value
}
afterEach(() => {
  for (const t of tables.splice(0)) t.dispose()
})

it('validates dimensions and the independent per-face layer limit', () => {
  expect(cardDefinition({}).size).toEqual([0.063, 0.088])
  expect(() => cardDefinition({ size: [0, 1] })).toThrow()
  expect(() => cardDefinition({ cornerRadius: 0.1 })).toThrow()
  expect(() =>
    cardDefinition({ front: { finishes: Array.from({ length: 5 }, () => ({})) } }),
  ).toThrow()
  expect(cardDefinition({ front: { finishes: [{}] } }).back.finishes).toEqual([])
})

it('transfers atomically, preserves IDs and deterministically shuffles', () => {
  const entries = Array.from({ length: 100 }, (_, i) => ({
    instanceId: String(i),
    definition: 'card',
  }))
  const a = new CardCollection('a', entries)
  const b = new CardCollection('b', entries)
  a.shuffle(77)
  b.shuffle(77)
  expect(a.snapshot().entries).toEqual(b.snapshot().entries)
  expect(a.snapshot().entries).not.toEqual(entries)
  const before = a.snapshot()
  expect(() => a.draw(2, b)).toThrow()
  expect(a.snapshot()).toEqual(before)
  const hand = new CardCollection('hand')
  a.draw(5, hand)
  expect(hand.snapshot().entries).toEqual(before.entries.slice(0, 5))
  expect(a.count).toBe(95)
  expect(() => hand.move(0, 5)).toThrow()
  expect(() => hand.insert(entries[0]!, -1)).toThrow()
})

it('writes symmetric fan poses and thickness-separated stack poses', () => {
  const a = new Float64Array(4),
    b = new Float64Array(4)
  cardPose({ kind: 'fan' }, 0, 9, a)
  cardPose({ kind: 'fan' }, 8, 9, b)
  expect(a[0]).toBeCloseTo(-b[0]!, 12)
  expect(a[1]).toBeCloseTo(b[1]!, 12)
  expect(a[3]).toBeCloseTo(-b[3]!, 12)
  cardPose({ kind: 'stack', spacing: 0.001 }, 4, 9, a)
  expect(Array.from(a)).toEqual([0, 0, 0.004, 0])
})

it('keeps automatic motion bounded, continuous, deterministic and different per phase', () => {
  const a = new Float32Array(2),
    b = new Float32Array(2)
  for (let i = 0; i < 1000; i++) {
    sampleCardMotion(i / 60, 4, 0.7, 0, a)
    expect(Math.max(Math.abs(a[0]!), Math.abs(a[1]!))).toBeLessThanOrEqual(0.700001)
  }
  sampleCardMotion(4 - 0.0001, 4, 0.7, 0, a)
  sampleCardMotion(4 + 0.0001, 4, 0.7, 0, b)
  expect(Array.from(a)).toEqual(Array.from(b))
  sampleCardMotion(4, 4, 0.7, 0.5, b)
  expect(Array.from(a)).not.toEqual(Array.from(b))
  sampleCardMotion(4, 4, 0.7, 0, b)
  expect(Array.from(a)).toEqual(Array.from(b))
})

describe('headless presentation and picking', () => {
  it('picks the nearest rounded face, rejects corners, mirrors back UVs and reuses slots', () => {
    const t = table(2),
      def = cardDefinition({ size: [0.06, 0.09], cornerRadius: 0.01 })
    const back = t.spawn(def, 'back')
    const front = t.spawn(def, 'front', { x: 0, y: 0, z: 0.01 })
    t.update(1 / 60, 0)
    const hit = createCardHit()
    expect(hitCards(t, [0.015, 0, 1], [0, 0, -1], hit)).toBe(true)
    expect(hit.card).toBe(front)
    expect(hit.u).toBeCloseTo(0.75)
    expect(hitCards(t, [0.029, 0.044, 1], [0, 0, -1], hit)).toBe(false)
    front.dispose()
    back.flip(0)
    t.update(1 / 60, 0)
    hitCards(t, [0.015, 0, 1], [0, 0, -1], hit)
    expect(hit.side).toBe('back')
    expect(hit.u).toBeCloseTo(0.75)
    const next = t.spawn(def, 'next')
    expect(next.slot).toBe(front.slot)
    expect(next.entity).not.toBe(front.entity)
    expect(() => t.spawn(def, 'overflow')).toThrow()
  })

  it('keeps pointer tilt opt-in, projects against the base pose and settles under reduced motion', () => {
    const t = table(),
      card = t.spawn(cardDefinition({}), 'card')
    card.setHover(1, 0, true)
    t.update(1 / 60, 0)
    expect(card.tiltX).toBe(0)
    card.tilt = true
    for (let i = 0; i < 120; i++) t.update(1 / 60, i / 60)
    expect(card.tiltX).toBeCloseTo(8, 1)
    expect(card.tiltY).toBeCloseTo(8, 1)
    const uv = new Float64Array(2)
    expect(cardTiltCoordinates(card, [0, 0, 1], [0, 0, -1], uv)).toBe(true)
    expect(Array.from(uv)).toEqual([0.5, 0.5])
    t.reducedMotion = true
    for (let i = 0; i < 120; i++) t.update(1 / 60, i / 60)
    expect(card.tiltX).toBe(0)
    card.flip()
    expect(card.duration).toBe(0)
  })

  it('animates foil without changing the pose, then freezes the shared clock for reduced motion', () => {
    const t = table(),
      card = t.spawn(cardDefinition({}), 'auto')
    card.setAutomaticMotion({ enabled: true })
    t.update(1 / 60, 0)
    const pose = Array.from(card.pose)
    t.update(1 / 60, 1 / 60)
    expect(Array.from(card.pose)).toEqual(pose)
    expect(card.tiltX).toBe(0)
    const clock = t.material.value.automaticClock
    t.reducedMotion = true
    t.update(1, 2)
    expect(t.material.value.automaticClock).toBe(clock)
    t.reducedMotion = false
    card.setAutomaticMotion({ enabled: true, tilt: true })
    t.update(1 / 60, 3)
    expect(Math.abs(card.tiltX) + Math.abs(card.tiltY)).toBeGreaterThan(0)
  })
})

it('builds opposite face normals and distinct mirrored back art coordinates', () => {
  const mesh = cardMesh(cardDefinition({})).data()
  const sides = new Set(mesh.uvs1!.filter((_, i) => i % 2 === 0))
  expect([...sides].sort()).toEqual([0, 1, 2])
  for (let i = 0; i < mesh.positions.length / 3; i++) {
    const side = mesh.uvs1![i * 2]
    if (side === 2) continue
    expect(mesh.normals![i * 3 + 2]).toBe(side === 0 ? 1 : -1)
    expect(mesh.uvs![i * 2]).toBeCloseTo(
      0.5 + ((side === 0 ? 1 : -1) * mesh.positions[i * 3]!) / 0.063,
      5,
    )
  }
})

it('deduplicates texture layers, keeps neutral coverage and enforces the budget', () => {
  const image = { width: 2, height: 2, kind: 'u8' as const, data: new Uint8Array(16).fill(128) }
  const page = prepareCardTextures(
    [
      { id: 'mask', image },
      { id: 'mask', image },
    ],
    { width: 2, height: 2, mask: true },
  )
  expect(page.indices.size).toBe(1)
  expect(page.texture.layers).toBe(2)
  expect(Array.from(page.texture.levels![0]!.subarray(0, 16))).toEqual(new Array(16).fill(255))
  expect(() => prepareCardTextures([], { width: 1024, height: 1024, budgetMiB: 1 })).toThrow()
})

it.skipIf(timingMode !== 'bench')(
  'updates 1,000 settled cards within the proposed 0.8 ms slice',
  () => {
    const t = table(),
      def = cardDefinition({})
    for (let i = 0; i < 1000; i++) t.spawn(def, String(i))
    for (let i = 0; i < 100; i++) t.update(1 / 60, i / 60)
    const start = performance.now()
    for (let i = 0; i < 600; i++) t.update(1 / 60, i / 60)
    expect((performance.now() - start) / 600).toBeLessThan(budget('cards/update'))
  },
)
