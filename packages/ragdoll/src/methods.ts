import { defineSchema, type Entity, ShardError, t, type World } from '@aethervtt/shard-core'
import type { AppMethod } from '@aethervtt/shard-runtime'
import { RagdollAssets } from './asset'
import { HIT_KINDS, type HitKind, Ragdoll, Reaction } from './components'
import { hit } from './reactions'
import { describeSim, RagdollSimResource } from './sim'

/** One root: its reaction, the asset's bodies and rests, and what the simulation does with it. */
export function describeRagdoll(world: World, root: Entity) {
  if (!world.has(root, Ragdoll)) {
    throw new ShardError('ragdoll/no-asset', `Entity ${root} has no ragdoll/Ragdoll`, {
      hint: 'ragdoll.describe without an entity lists every simulated ragdoll.',
    })
  }
  const r = world.get(root, Ragdoll)
  const asset = r.asset ? world.tryResource(RagdollAssets)?.get(r.asset) : undefined
  const reaction = world.tryGet(root, Reaction)
  const sim = describeSim(world)
  return {
    entity: root,
    drive: r.drive,
    asset: asset
      ? {
          mass: asset.mass,
          bodies: asset.bodies.map((b) => ({
            joint: b.joint,
            zone: b.zone,
            kind: b.limits?.kind ?? 'root',
          })),
          rests: asset.rests.map((x) => x.name),
          roles: asset.roleNames,
        }
      : null,
    reaction: reaction
      ? {
          ...reaction,
          bone: asset?.bodies[reaction.bone]?.joint ?? reaction.bone,
          rest: asset?.rests[reaction.rest]?.name ?? null,
          role: reaction.role === 255 ? null : (asset?.roleNames[reaction.role] ?? reaction.role),
        }
      : null,
    simulation: sim?.active.find((a) => a.root === root) ?? null,
    corpse: world.tryResource(RagdollSimResource)?.corpses.has(root) ?? false,
  }
}

export const ragdollMethods: AppMethod[] = [
  {
    name: 'ragdoll.describe',
    description:
      'Ragdolls (0117). Without an entity: simulated ragdolls (state, mode, weights and drive strengths per body), bodies made and pooled, corpses, activations, clip fallbacks, evictions, and the drive and blend systems’ ms. With an entity: its Reaction (stagger, bone, rest, role), its asset’s bodies, rests and roles, and its simulation.',
    params: defineSchema('ragdoll/DescribeParams', {
      entity: t.entity({ description: 'A ragdoll root (or its scene path).' }),
    }),
    handler: ({ world }, p) => {
      const entity = p.entity as Entity | null
      if (entity !== null && entity !== undefined && entity >= 0)
        return describeRagdoll(world, entity)
      return describeSim(world) ?? { active: [], bodies: 0, pooledBodies: 0, corpses: 0 }
    },
  },
  {
    name: 'ragdoll.hit',
    description:
      'Hits a ragdoll root (0117), as a game would: impulse (N·s) at a bone or point, or a launch velocity (m/s, a car); kind auto, partial, knockdown or death. Returns its Reaction after.',
    params: defineSchema('ragdoll/HitParams', {
      entity: t.entity({ description: 'The ragdoll root.' }),
      bone: t.string({
        description: 'The body hit, by joint name (empty: the point picks, else the root body).',
      }),
      point: t.list(t.f32, { description: 'Where it landed, world [x, y, z].' }),
      impulse: t.list(t.f32, { description: 'N·s, world [x, y, z].' }),
      launch: t.list(t.f32, { description: 'A velocity for every body instead, m/s [x, y, z].' }),
      kind: t.string({ default: 'auto', description: 'auto, partial, knockdown or death.' }),
    }),
    handler: ({ world }, p) => {
      const entity = p.entity as Entity
      const kind = (p.kind as string) || 'auto'
      if (!(HIT_KINDS as readonly string[]).includes(kind)) {
        throw new ShardError('ragdoll/bad-hit', `Unknown hit kind "${kind}"`, {
          hint: `One of ${HIT_KINDS.join(', ')}.`,
        })
      }
      const list = (v: unknown) =>
        Array.isArray(v) && v.length === 3 ? (v as number[]) : undefined
      hit(world, entity, {
        ...(p.bone ? { bone: p.bone as string } : {}),
        ...(list(p.point) ? { point: list(p.point)! } : {}),
        ...(list(p.impulse) ? { impulse: list(p.impulse)! } : {}),
        ...(list(p.launch) ? { launch: list(p.launch)! } : {}),
        kind: kind as HitKind,
      })
      return describeRagdoll(world, entity).reaction
    },
  },
]
