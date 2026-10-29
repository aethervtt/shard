import {
  defineEvent,
  defineResource,
  defineSystem,
  type JsonValue,
  Last,
  PreUpdate,
  Rng,
  t,
  type World,
} from '@aethervtt/shard-core'
import {
  defineNetEvent,
  NetSystems,
  onClient,
  onServer,
  type PeerId,
  Peers,
  sendEvent,
} from '@aethervtt/shard-net'
import { definePlugin, GlobalRng, type Plugin } from '@aethervtt/shard-runtime'
import { CardCollection, type CardEntry } from './collection'

// Hidden information for card zones (0089). The server keeps the real collections; each peer
// receives its own view of every zone, with cards it may not see as placeholders. This module
// imports no renderer, so a headless server can use it.

/** The definition a hidden card carries: the host draws it as the card's back. */
export const HIDDEN_CARD = 'cards/hidden'

/** One peer's view of one zone. List it in `netPlugin({ events })` on both sides. */
export const ZoneView = defineNetEvent('cards/ZoneView', {
  zone: t.string(),
  entries: t.json(),
  /** `[placeholder, instanceId]` pairs: cards this peer could not see before and now can. */
  revealed: t.json(),
})

/** Client: a placeholder the presentation shows became a real card (flip it in place). */
export const CardRevealed = defineEvent<{ zone: string; placeholder: string; instanceId: string }>(
  'cards/CardRevealed',
)

/** Client: the zones as this peer sees them, by id. Server: unused. */
export const NetCardZones = defineResource<Map<string, CardCollection>>('cards/NetCardZones', {
  description: 'Card zones as this client may see them (0089).',
  init: () => new Map(),
})

export interface NetCardsOptions {
  /** Server: the authoritative zones. Read every network tick; send when a version changes. */
  zones?: (world: World) => Iterable<CardCollection>
  /** Server: whether `peer` may see the card at `index` of `zone`. */
  visibleTo?: (
    world: World,
    peer: PeerId,
    zone: CardCollection,
    entry: CardEntry,
    index: number,
  ) => boolean
}

interface PeerView {
  /** Zone id → version last sent. */
  readonly versions: Map<string, number>
  /** Real id → placeholder this peer last saw it as. */
  readonly placeholders: Map<string, string>
}

/**
 * Replicates `CardCollection` zones with per-peer redaction (0089). Add it on both sides, and
 * add `ZoneView` to `netPlugin({ events })`.
 */
export function netCardsPlugin(options: NetCardsOptions = {}): Plugin {
  const views = new Map<PeerId, PeerView>()
  let rng: Rng | undefined

  const placeholder = (): string => {
    rng ??= new Rng(0)
    // Two words: ids can't be guessed from each other.
    return `hidden-${rng.nextU32().toString(36)}${rng.nextU32().toString(36)}`
  }

  const publish = defineSystem({
    name: 'cards/net-publish',
    description: 'Sends each peer its view of every zone whose version changed.',
    run(_, world) {
      if (!options.zones) return
      rng ??= world.resource(GlobalRng).fork('cards/net')
      const peers = world.resource(Peers)
      for (const id of views.keys()) if (!peers.has(id)) views.delete(id)
      for (const zone of options.zones(world)) {
        const snapshot = zone.snapshot()
        for (const peer of peers.keys()) {
          let view = views.get(peer)
          if (!view) {
            view = { versions: new Map(), placeholders: new Map() }
            views.set(peer, view)
          }
          if (view.versions.get(zone.id) === zone.version) continue
          view.versions.set(zone.id, zone.version)
          const entries: CardEntry[] = []
          const revealed: [string, string][] = []
          snapshot.entries.forEach((entry, index) => {
            const visible = options.visibleTo?.(world, peer, zone, entry, index) ?? !entry.faceDown
            if (visible) {
              const was = view.placeholders.get(entry.instanceId)
              if (was !== undefined) {
                revealed.push([was, entry.instanceId])
                view.placeholders.delete(entry.instanceId)
              }
              entries.push({ ...entry })
              return
            }
            // A fresh placeholder on every change, so a hidden card can't be followed.
            const id = placeholder()
            view.placeholders.set(entry.instanceId, id)
            entries.push({ instanceId: id, definition: HIDDEN_CARD, faceDown: true })
          })
          sendEvent(
            world,
            ZoneView,
            { zone: zone.id, entries: entries as unknown as JsonValue, revealed },
            { to: peer },
          )
        }
      }
    },
  })

  const apply = defineSystem({
    name: 'cards/net-apply',
    description: 'Rebuilds the client zones from the views the server sent.',
    run(_, world, ctx) {
      const zones = world.resource(NetCardZones)
      for (const { data } of ctx.reader(ZoneView.event).read()) {
        let zone = zones.get(data.zone)
        if (!zone) {
          zone = new CardCollection(data.zone)
          zones.set(data.zone, zone)
        }
        while (zone.count > 0) zone.remove(zone.count - 1)
        for (const entry of data.entries as unknown as CardEntry[]) zone.insert(entry)
        for (const [placeholder, instanceId] of data.revealed as unknown as [string, string][]) {
          world.send(CardRevealed, { zone: data.zone, placeholder, instanceId })
        }
      }
    },
  })

  return definePlugin({
    name: 'cards/net',
    dependencies: ['net'],
    build(app) {
      app.world.initResource(NetCardZones)
      app.addSystems(Last, publish.before(NetSystems.send).runIf(onServer))
      app.addSystems(PreUpdate, apply.runIf(onClient))
    },
  })
}
