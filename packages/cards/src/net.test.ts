import { defineSystem, PreUpdate } from '@aethervtt/shard-core'
import { NetRole } from '@aethervtt/shard-net'
import { type NetHarness, netHarness } from '@aethervtt/shard-net/testing'
import { afterEach, expect, it } from 'vitest'
import { CardCollection, type CardEntry } from './collection'
import { CardRevealed, HIDDEN_CARD, NetCardZones, netCardsPlugin, ZoneView } from './net'

let net: NetHarness | undefined
afterEach(async () => {
  await net?.dispose()
  net = undefined
})

it('keeps hands and the deck secret over 50 turns, with fresh placeholders after a shuffle', async () => {
  const deck = new CardCollection(
    'deck',
    Array.from({ length: 40 }, (_, i) => ({
      instanceId: `c${i}`,
      definition: `card-${i}`,
      faceDown: true,
    })),
  )
  const table = new CardCollection('table')
  const hands = [new CardCollection('hand-0'), new CardCollection('hand-1')]
  const zones = [deck, table, ...hands]
  const ownerOf = new Map<string, number>()

  net = await netHarness({
    clients: 2,
    plugins: () => [],
    server: () => [
      netCardsPlugin({
        zones: () => zones,
        visibleTo: (_w, peer, zone) =>
          zone === table || (zone.id.startsWith('hand-') && ownerOf.get(zone.id) === peer),
      }),
    ],
    client: () => [netCardsPlugin()],
    net: { events: [ZoneView] },
    conditions: { latency: 0.05, jitter: 0.02, seed: 4 },
  })
  await net.connect()
  net.clients.forEach((c, i) => {
    ownerOf.set(`hand-${i}`, c.world.resource(NetRole).peer)
  })

  // Record every view each client decodes, and every reveal.
  const seen = net.clients.map(() => [] as { zone: string; entries: CardEntry[] }[])
  const reveals = net.clients.map(() => [] as string[])
  net.clients.forEach((c, i) => {
    c.addSystems(
      PreUpdate,
      defineSystem({
        name: `cardstest/tap${i}`,
        run: (_, _w, ctx) => {
          for (const { data } of ctx.reader(ZoneView.event).read()) {
            seen[i]!.push({ zone: data.zone, entries: data.entries as unknown as CardEntry[] })
          }
          for (const r of ctx.reader(CardRevealed).read()) reveals[i]!.push(r.instanceId)
        },
      }),
    )
  })

  deck.shuffle(1)
  deck.draw(7, hands[0]!)
  deck.draw(7, hands[1]!)
  net.step(20)
  const before = new Set(
    net.clients[0]!.world.resource(NetCardZones)
      .get('deck')!
      .snapshot()
      .entries.map((e) => e.instanceId),
  )
  deck.shuffle(2)
  net.step(20)
  const after = net.clients[0]!.world.resource(NetCardZones)
    .get('deck')!
    .snapshot()
    .entries.map((e) => e.instanceId)
  expect(after.filter((id) => before.has(id))).toEqual([])

  for (let turn = 0; turn < 50; turn++) {
    const hand = hands[turn % 2]!
    if (deck.count === 0) {
      while (table.count > 0) deck.insert({ ...table.remove(0), faceDown: true })
      deck.shuffle(100 + turn)
    }
    deck.draw(1, hand)
    const played = hand.remove(0)
    table.insert({ ...played, faceDown: false })
    net.step(6)
  }
  net.step(20)

  for (let i = 0; i < 2; i++) {
    const other = `hand-${1 - i}`
    for (const view of seen[i]!) {
      if (view.zone !== 'deck' && view.zone !== other) continue
      for (const entry of view.entries) expect(entry.definition).toBe(HIDDEN_CARD)
    }
    // The client's zones match the server's, as it may see them.
    const mine = net.clients[i]!.world.resource(NetCardZones)
    expect(mine.get(`hand-${i}`)!.snapshot().entries).toEqual(hands[i]!.snapshot().entries)
    expect(
      mine
        .get('table')!
        .snapshot()
        .entries.map((e) => e.definition),
    ).toEqual(table.snapshot().entries.map((e) => e.definition))
    expect(mine.get(other)!.count).toBe(hands[1 - i]!.count)
    // Drawn cards flip in place: each draw into this hand was a reveal.
    expect(reveals[i]!.length).toBeGreaterThan(20)
  }
})
