import { defineSchema, type Entity, ShardError, t, type World } from '@aethervtt/shard-core'
import { Instances } from '@aethervtt/shard-render'
import type { AppMethod } from '@aethervtt/shard-runtime'
import { SIM_TIERS, TIERS } from './components'
import { bakeBytes, CharacterRigs } from './rig'
import { jointEntityCount, RigPool } from './rigs'
import { CharacterStates } from './spawn'
import { TierRunResource } from './tiers'

const SOURCES = ['joints', 'pose', 'baked'] as const

/** One character: tiers, screen size, build, parts and pose source. */
export function describeCharacter(world: World, entity: Entity) {
  const s = world.tryResource(CharacterStates)?.get(entity)
  if (!s) {
    throw new ShardError('characters/no-character', `Entity ${entity} isn't a character`, {
      hint: 'characters.describe without an entity lists counts for every character.',
    })
  }
  return {
    entity,
    rig: s.rig.name,
    build: s.rig.builds[s.build]!.name,
    tier: TIERS[s.tier],
    sim: SIM_TIERS[s.simTier],
    pinned: s.pinned,
    since: s.since,
    parts: s.parts.length,
    merged: s.merged !== null,
    source:
      s.tier === 0 ? SOURCES[0] : s.tier === 1 ? SOURCES[1] : s.tier === 2 ? SOURCES[2] : null,
    poseRange: s.poseBase,
    header: s.header,
    morphs: s.morphCount,
    ik: s.ik,
  }
}

/** Counts per tier and sim tier, swaps, joints sampled, rigs, bakes and timings. */
export function describeCharacters(world: World) {
  const run = world.tryResource(TierRunResource)?.run
  const pool = world.tryResource(RigPool)
  const rigs = [...(world.tryResource(CharacterRigs)?.values() ?? [])]
  const stats = run?.stats
  return {
    characters: world.tryResource(CharacterStates)?.size ?? 0,
    tiers: Object.fromEntries(TIERS.map((t, i) => [t, stats?.counts[i] ?? 0])),
    sim: Object.fromEntries(SIM_TIERS.map((t, i) => [t, stats?.simCounts[i] ?? 0])),
    pinned: stats?.pinned ?? 0,
    swaps: stats?.swaps ?? 0,
    jointsSampled: stats?.jointsSampled ?? 0,
    rigs: {
      inUse: pool?.inUse ?? 0,
      pooled: [...(pool?.free.values() ?? [])].reduce((n, l) => n + l.length, 0),
      jointEntities: jointEntityCount(world),
    },
    bakes: rigs.map((r) => ({
      rig: r.name,
      builds: r.builds.map((b) => ({ name: b.name, baked: b.bake !== undefined })),
      bytes: bakeBytes(r),
    })),
    persistentBytes: (world.tryResource(Instances)?.deform.persistentEnd ?? 0) * 16,
    ms: { select: stats?.selectMs ?? 0, sample: stats?.sampleMs ?? 0 },
  }
}

export const characterMethods: AppMethod[] = [
  {
    name: 'characters.describe',
    description:
      'Character tiers (0115). Without an entity: characters per tier (near, mid, far, off) and sim tier, pinned characters, swaps this frame, joints sampled, rigs in use and pooled, joint entities, bake bytes per rig and build, and the select and sample systems’ ms. With an entity: its rig, build, tier, sim tier, pin, parts, merged far body, pose source and ranges.',
    params: defineSchema('characters/DescribeParams', {
      entity: t.entity({ description: 'A character root (or its scene path).' }),
    }),
    handler: ({ world }, p) => {
      const entity = p.entity as Entity | null
      if (entity !== null && entity !== undefined && entity >= 0)
        return describeCharacter(world, entity)
      return describeCharacters(world)
    },
  },
]
