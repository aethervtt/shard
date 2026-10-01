import { assetServer } from '@aethervtt/shard-assets'
import type { AssetRef } from '@aethervtt/shard-core'
import type { ShaderVariantSource } from '@aethervtt/shard-render'
import { DIE_KINDS, type DieKind } from './builtins'
import { renderDiceThumbnail } from './preview'
import { DiceSkin } from './skin'

// `shaders.variants.json`'s `{ "dice": … }` entries (0064): every skin, as each die kind, in both
// the looks that make different pipelines (its own, and blended: dropped dice, reduced motion and
// see-through families draw blended; large pools draw them opaque). A bake records what they draw.

export interface DiceVariantEntry {
  /** Skins by path or guid, or "*": every skin loaded or in the catalog. Default "*". */
  skins?: '*' | string[]
  /** Die kinds, or "*". Default "*". */
  kinds?: '*' | DieKind[]
}

export const diceVariants: ShaderVariantSource = {
  name: 'dice',
  description:
    'Dice skins × die kinds, opaque and blended: { skins?: "*" | [path|guid], kinds?: "*" | [kind] }.',
  async show(app, entry) {
    const e = (entry ?? {}) as DiceVariantEntry
    const world = app.world
    const store = world.resource(DiceSkin.store)
    const ref = (guid: string | undefined, path?: string): AssetRef => ({
      type: DiceSkin.name,
      guid,
      path,
    })
    const skins: AssetRef[] = []
    if (e.skins === undefined || e.skins === '*') {
      // The catalog's skins, loaded, and every skin already in the store (the built-in ones).
      const server = assetServer(world)
      for (const asset of server.list({ type: DiceSkin.name })) {
        await server.load(ref(asset.guid, asset.path))
      }
      for (const [guid] of store.entries()) skins.push(ref(guid))
    } else {
      for (const s of e.skins) {
        // A guid the store has (built-in skins: dice:skin/ivory), else a path (*.json) or a guid.
        const skin = !store.get(ref(s)) && s.endsWith('.json') ? ref(undefined, s) : ref(s)
        if (!store.get(skin)) await assetServer(world).load(skin)
        skins.push(skin)
      }
    }
    const kinds = e.kinds === undefined || e.kinds === '*' ? DIE_KINDS : e.kinds
    let shown = 0
    for (const skin of skins) {
      for (const kind of kinds) {
        for (const blended of [false, true]) {
          await renderDiceThumbnail(app, { skin, kind, value: 1, size: 32, blended })
          shown++
        }
      }
    }
    return shown
  },
}
