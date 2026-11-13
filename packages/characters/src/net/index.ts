// Hordes past replication (0115). Nothing registers on import: add hordesPlugin(), spread
// hordeReplicate() into both sides' replicate, and combine hordeInterest() into the server's.

export { type CharacterLook, characterLooks, characterLooks as hordeLooks } from '../looks'
export { HordeProxy } from '../tiers'
export {
  HANDOFF_SECONDS,
  HordeClient,
  type HordeClientStats,
  hordeClientStats,
  hordeProxies,
  hordeProxyOf,
} from './client'
export {
  ACTIVITIES,
  ATTACK,
  HordeCell,
  HordeMember,
  HordeMembers,
  hordeCellCodec,
  hordeMembersCodec,
  IDLE,
  type MemberPose,
  packMember,
  unpackMember,
  WALK,
  Y_STEP,
  yFits,
} from './components'
export { type HordeInterestOptions, hordeEvery, hordeInterest } from './interest'
export { hordeReplicate, hordesPlugin } from './plugin'
export {
  HORDE_PERIOD,
  HordeServer,
  type HordeServerOptions,
  type HordeServerStats,
  hordeServerStats,
  hordesSystem,
} from './server'
