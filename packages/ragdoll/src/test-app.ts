/** A test app: the characters fixture (Risen's body, CMU clips) with physics and ragdolls. Node. */
import { AnimationPlayer, animationLayer } from '@aethervtt/shard-animation'
import { CharacterStates } from '@aethervtt/shard-characters'
import {
  type Ctx,
  startCharacters,
  stopCharacters,
  zombie,
} from '@aethervtt/shard-characters/testing'
import type { AssetRef, Entity, JsonObject, World } from '@aethervtt/shard-core'
import type { GpuContext } from '@aethervtt/shard-gpu'
import type { Mesh } from '@aethervtt/shard-mesh'
import { Collider, physics3dPlugin, RigidBody } from '@aethervtt/shard-physics'
import { Mesh3d, Meshes, Skins } from '@aethervtt/shard-render'
import type { Plugin } from '@aethervtt/shard-runtime'
import { Transform } from '@aethervtt/shard-transform'
import { parseRagdoll, RagdollAssets } from './asset'
import { Ragdoll, type RagdollBudgetValue } from './components'
import { generateRagdoll } from './gen'
import { ragdollPlugin, reactionsPlugin } from './plugin'
import { HUMANOID_RESTS, registerRestClips } from './testing'

export interface RagdollCtx extends Ctx {
  json: JsonObject
  asset: AssetRef<'Ragdoll'>
}

/** The rig's part meshes (CPU copies) for generation. */
export function partMeshes(world: World, character: Entity): Mesh[] {
  const st = world.resource(CharacterStates).get(character)!
  const meshes = world.resource(Meshes)
  const out: Mesh[] = []
  for (const part of st.parts) {
    const ref = world.get(part, Mesh3d).mesh
    const m = ref ? meshes.get(ref) : undefined
    if (m?.joints && m.weights) out.push(m)
  }
  return out
}

/**
 * The fixture app with physics3d, reactions and ragdolls, a ground, a generated humanoid ragdoll
 * with the stand-in rests, and the stand-in clips registered.
 */
export async function startRagdolls(
  gpu: GpuContext,
  budget: Partial<RagdollBudgetValue> = {},
  extra: (json: JsonObject) => void = () => {},
  plugins: Plugin[] = [],
): Promise<RagdollCtx> {
  const c = await startCharacters(
    gpu,
    { maxNear: 32 },
    [640, 360],
    [
      physics3dPlugin({ deterministic: true }),
      reactionsPlugin(),
      ragdollPlugin(budget),
      ...plugins,
    ],
  )
  const world = c.world
  world.spawn(
    [RigidBody, { kind: 'fixed' }],
    [Collider, { shape: 'cuboid', halfExtents: [100, 0.5, 100], friction: 0.9 }],
    [Transform, { translation: [0, -0.5, 0] }],
  )
  // Generate from a character's parts.
  const probe = zombie(c, 3)
  const json = generateRagdoll(
    { skeleton: c.rig.skeleton, rest: c.rig.builds[0]!.rest, meshes: partMeshes(world, probe) },
    { skeleton: 'assets/risen/base.glb' },
  )
  world.despawn(probe)
  json.rests = structuredClone(HUMANOID_RESTS)
  extra(json)
  const asset = world
    .resource(RagdollAssets)
    .add(parseRagdoll(json), 'humanoid') as AssetRef<'Ragdoll'>
  // The rests' stand-in clips, on the clips' own skeleton (the rig retargets them).
  const skin = world.resource(Skins).get(c.fixture.clips.walk.skin)!
  registerRestClips(world, skin)
  return { ...c, json, asset }
}

/** A walking zombie `d` m in front of the camera, with a ragdoll. */
export function ragdollZombie(
  c: RagdollCtx,
  d: number,
  x = 0,
  drive: 'auto' | 'game' = 'auto',
): Entity {
  const e = zombie(c, d, { x })
  c.world.add(e, Ragdoll, { asset: c.asset, drive })
  return e
}

/** Restarts a zombie's walk at `time` (so two zombies match frame for frame). */
export function walkAt(c: RagdollCtx, e: Entity, time: number): void {
  c.world.set(e, AnimationPlayer, {
    ...c.world.get(e, AnimationPlayer),
    layers: [animationLayer(c.fixture.clips.walk.clip, { time })],
  })
}

export { stopCharacters as stopRagdolls }
