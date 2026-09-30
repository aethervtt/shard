import { defineComponent, t } from '@aethervtt/shard-core'

/**
 * On an entity drawing a fallback for an asset that failed to load (0061): which asset and why.
 * The host queries it to show a badge; `assets.retry(ref)` reloads the asset, and on success the
 * entity switches back and loses this marker, without respawning.
 */
export const MissingAsset = defineComponent(
  'assets/MissingAsset',
  {
    ref: t.string({ description: 'The asset path (or guid) that failed.' }),
    code: t.string({ description: "The load error's code, such as assets/load-failed." }),
    message: t.string({ description: "The load error's message." }),
  },
  {
    description:
      'This entity shows a fallback for an asset that failed to load (0061). assets.retry(ref) reloads it.',
    serialize: false,
  },
)
