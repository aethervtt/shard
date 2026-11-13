import { Last, onAdd, Update } from '@aethervtt/shard-core'
import {
  NetRole,
  NetSystems,
  onClient,
  onServer,
  type ReplicationEntry,
  replicate,
} from '@aethervtt/shard-net'
import { definePlugin, type Plugin } from '@aethervtt/shard-runtime'
import { hordeProxies } from './client'
import {
  HordeCell,
  HordeMember,
  HordeMembers,
  hordeCellCodec,
  hordeMembersCodec,
} from './components'
import { type HordeServerOptions, hordesSystem, noteMemberId } from './server'

/**
 * What hordes replicate, for `netPlugin({ replicate: [...hordeReplicate(), …] })` on both sides:
 * HordeMember (so a client matches live zombies to proxies), and HordeCell and HordeMembers
 * through their packed codecs.
 */
export function hordeReplicate(): ReplicationEntry[] {
  return [
    replicate(HordeMember),
    replicate(HordeCell, { codec: hordeCellCodec }),
    replicate(HordeMembers, { codec: hordeMembersCodec }),
  ]
}

/**
 * Hordes past replication (0115). Server: `characters/hordes` keeps a HordeCell per occupied cell
 * near a player, and gives members spawned with id 0 an id. Client: `characters/horde-proxies`
 * draws far proxies (looks from `characterLooks`). Without the net plugin it does nothing. Add
 * `hordeInterest()` to the server's interest and `hordeReplicate()` to both sides' replicate.
 */
export function hordesPlugin(options: HordeServerOptions = {}): Plugin {
  return definePlugin({
    name: 'characters/hordes',
    dependencies: ['partition', 'characters'],
    build(app) {
      if (!app.hasPlugin('net')) return
      app.addSystems(Last, hordesSystem(options).runIf(onServer).before(NetSystems.send))
      app.addSystems(Update, hordeProxies.runIf(onClient))
    },
    ready(app) {
      const world = app.world
      if (world.tryResource(NetRole)?.role !== 'server') return
      world.observe(onAdd(HordeMember), ({ entity, world }) => noteMemberId(world, entity))
    },
  })
}
