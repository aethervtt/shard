import { sampleAnimations } from '@aethervtt/shard-animation'
import {
  ChildOf,
  defineSystem,
  FixedUpdate,
  onAdd,
  onRemove,
  PostUpdate,
  Update,
} from '@aethervtt/shard-core'
import {
  CharacterController,
  Collider,
  Physics,
  PhysicsConfig,
  PhysicsSystems,
  RigidBody,
} from '@aethervtt/shard-physics'
import { definePlugin, type Plugin } from '@aethervtt/shard-runtime'
import { Transform, TransformSystems } from '@aethervtt/shard-transform'
import * as assetModule from './asset'
import { RagdollAssets } from './asset'
import * as componentsModule from './components'
import { Ragdoll, RagdollBudget, type RagdollBudgetValue, Reaction } from './components'
import { ragdollMethods } from './methods'
import { ragdollOverlay } from './overlay'
import { reactionsSystem, setLocalLanding } from './reactions'
import {
  blendSystem,
  driveSystem,
  installSimSources,
  RAGDOLL_LAYER,
  RagdollClipNames,
  RagdollSimResource,
  reactSystem,
} from './sim'

/** A root marked for a sensor capsule (it has no collider of its own). */
const pendingCapsules = new WeakMap<object, Set<number>>()

/**
 * Gives ragdoll roots without a collider a kinematic sensor capsule, sized from the asset's rest,
 * so physics rays find them (castHit refines against the bones). Update.
 */
const capsules = defineSystem({
  name: 'ragdoll/capsules',
  description:
    'Adds a kinematic sensor capsule under ragdoll roots that have no collider, for bone-accurate rays.',
  run: (_, world) => {
    const pending = pendingCapsules.get(world)
    if (!pending || pending.size === 0 || !world.tryResource(Physics)) return
    const store = world.tryResource(RagdollAssets)
    for (const root of pending) {
      if (!world.isAlive(root) || !world.has(root, Ragdoll)) {
        pending.delete(root)
        continue
      }
      const asset = store?.get(world.get(root, Ragdoll).asset!)
      if (!asset) continue
      pending.delete(root)
      if (world.has(root, Collider) || world.has(root, CharacterController)) continue
      // Height from the rest poses when known.
      let top = 0
      for (const b of asset.bodies) if (b.rest && b.rest[1]! > top) top = b.rest[1]!
      const height = top > 0.5 ? top + 0.15 : 1.8
      const radius = Math.min(0.35, height * 0.18)
      world.spawn(
        [Transform, { translation: [0, height / 2, 0] }],
        [RigidBody, { kind: 'kinematic-position' }],
        [
          Collider,
          { shape: 'capsule', radius, halfHeight: Math.max(0, height / 2 - radius), sensor: true },
        ],
        [ChildOf, { parent: root }],
      )
    }
  },
})

/**
 * Reactions (0117), on servers and clients: the Ragdoll asset type, Reaction state, stagger,
 * rests and slides (`hit`), the reactions clock, sensor capsules for rays, and the agent methods.
 * Clients that show ragdolls add `ragdollPlugin` too.
 */
export function reactionsPlugin(): Plugin {
  return definePlugin({
    name: 'ragdoll/reactions',
    provides: [assetModule, componentsModule, ragdollOverlay],
    dependencies: ['core/transform'],
    build(app) {
      const w = app.world
      w.initResource(RagdollAssets)
      w.initResource(RagdollBudget)
      w.initResource(RagdollSimResource)
      const pending = new Set<number>()
      pendingCapsules.set(w, pending)
      w.observe(onAdd(Ragdoll), ({ entity, world }) => {
        if (!world.has(entity, Reaction)) world.add(entity, Reaction, { role: 255 })
        pending.add(entity)
      })
      app.addSystems(Update, reactionsSystem)
      app.addSystems(Update, capsules)
      app.addMethod(...ragdollMethods)
    },
  })
}

/**
 * Ragdoll simulation and physical animation (0117), for apps that draw: pooled bodies, partial
 * reactions blended into the animation, full ragdolls, rest blends, get-ups (drive auto) and
 * frozen corpses. Needs physics3d, animation and reactionsPlugin.
 */
export function ragdollPlugin(options: Partial<RagdollBudgetValue> = {}): Plugin {
  return definePlugin({
    name: 'ragdoll',
    dependencies: ['ragdoll/reactions', 'physics3d', 'animation'],
    build(app) {
      const w = app.world
      Object.assign(w.initResource(RagdollBudget), options)
      w.initResource(RagdollSimResource)
      w.initResource(RagdollClipNames)
      if (!w.resource(RagdollBudget).blockCharacters) {
        const config = w.resource(PhysicsConfig)
        config.characterIgnores = config.characterIgnores | RAGDOLL_LAYER
      }
      installSimSources(w)
      setLocalLanding(w)
      // A root despawned or stripped of its ragdoll: forget its corpse and clip bookkeeping.
      w.observe(onRemove(Ragdoll), ({ entity, world }) => {
        const sim = world.resource(RagdollSimResource)
        sim.corpses.delete(entity)
        sim.clips.delete(entity)
      })
      app.addSystems(FixedUpdate, driveSystem.before(PhysicsSystems))
      app.addSystems(PostUpdate, reactSystem.before(sampleAnimations))
      app.addSystems(PostUpdate, blendSystem.after(sampleAnimations).before(TransformSystems))
    },
  })
}
