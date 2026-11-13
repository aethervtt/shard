import { onAdd, onRemove, PostUpdate, Update } from '@aethervtt/shard-core'
import { computeVisibility } from '@aethervtt/shard-render'
import { definePlugin, type Plugin } from '@aethervtt/shard-runtime'
import { TransformSystems } from '@aethervtt/shard-transform'
import * as componentsModule from './components'
import { Character, TierBudget, type TierBudgetValue } from './components'
import { composeLooks, PendingLooks } from './compose'
import { CharacterLooks } from './looks'
import { characterMethods } from './methods'
import { tiersOverlay } from './overlay'
import { CharacterRigs } from './rig'
import { RigPool, returnRig } from './rigs'
import { CharacterStates, forgetCharacter } from './spawn'
import { sampleTiers, selectTiers, TierRunResource } from './tiers'

/**
 * Character tiers (0115): rigs, composed characters, and the representation each one gets (near
 * joint rigs, mid pose buffers, far baked clips, off), chosen every frame. Headless apps get sim
 * tiers and no rigs unless `serverRigs`.
 */
export function charactersPlugin(options: Partial<TierBudgetValue> = {}): Plugin {
  return definePlugin({
    name: 'characters',
    provides: [componentsModule, tiersOverlay],
    // Animation is a display plugin: a headless server runs tiers without it (players hold data).
    dependencies: ['core/transform'],
    build(app) {
      const w = app.world
      w.initResource(CharacterRigs)
      w.initResource(CharacterStates)
      w.initResource(RigPool)
      w.initResource(TierRunResource)
      Object.assign(w.initResource(TierBudget), options)
      w.observe(onRemove(Character), ({ entity, world }) =>
        forgetCharacter(world, entity, (s) => returnRig(world, s)),
      )
      // A root that arrives without a state (replicated) is composed from its look in Update.
      w.initResource(CharacterLooks)
      const pending = w.initResource(PendingLooks)
      w.observe(onAdd(Character), ({ entity }) => {
        pending.entities.push(entity)
      })
      app.addSystems(Update, composeLooks)
      const select = app.hasPlugin('render/forward')
        ? selectTiers.after(TransformSystems).before(computeVisibility)
        : selectTiers.after(TransformSystems)
      app.addSystems(PostUpdate, select)
      app.addSystems(PostUpdate, sampleTiers.after(selectTiers))
      app.addMethod(...characterMethods)
    },
  })
}
