import {
  defineComponent,
  defineResource,
  type Entity,
  onAdd,
  t,
  type World,
} from '@aethervtt/shard-core'
import { Camera3d } from './camera'
import { warnFeatureMissing } from './features'
import type { HiddenSets } from './view-visibility-plugin'

// Per-view hiding (0070): a camera's list of entities it doesn't draw, resolved to a bitset of
// instance slots that its culls (CPU and GPU) test. The component and the culls' test are core;
// resolving the lists is `viewVisibilityPlugin`, which forwardPlugin includes.

export const VIEW_SHADOWS = ['keep', 'hide'] as const

export const ViewVisibility = defineComponent(
  'render/ViewVisibility',
  {
    hide: t.list(t.entity, {
      description: "Entities this camera doesn't draw, with their descendants.",
    }),
    shadows: t.enum(VIEW_SHADOWS, {
      description:
        "keep: they still cast into this camera's shadows (a body its own camera doesn't draw). hide: its cascades leave them out too. Spot and point shadow maps are shared by every camera and always keep them.",
    }),
  },
  {
    description:
      'Hides entities from one camera (0070): other cameras still draw them. For a first-person body, split-screen markers, or a game master previewing a player view.',
    requires: [Camera3d],
  },
)

/** `hiddenBase` of a view with no hidden set. */
export const NO_HIDDEN = 0xffffffff

/** One camera's hidden set: a bit per instance slot, in its range of `HiddenSets.data`. */
export interface HiddenSet {
  camera: Entity
  /** Its first word in `HiddenSets.data` (and the GPU buffer). */
  base: number
  /** Its words: bit `s & 31` of word `s >> 5` is slot `s`. */
  bits: Uint32Array
  /** Slots it resolves to. */
  slots: number
  /** The entities listed, as last resolved. */
  hide: Entity[]
  /** Its camera's cascades leave the slots out too. */
  shadows: boolean
  /** The frame it was last seen on (sets of cameras that lose the component are freed). */
  frame: number
}

export const HiddenSetsResource = defineResource<HiddenSets>('render/HiddenSets', {
  description: "Each camera's hidden slots (ViewVisibility, 0070), as the culls read them.",
})

/** Warns once per world about a ViewVisibility without its plugin (render/feature-missing). */
export function observeViewVisibilityWithoutPlugin(world: World): void {
  world.observe(onAdd(ViewVisibility), ({ world: w }) => {
    if (!w.hasResource(HiddenSetsResource))
      warnFeatureMissing(
        w,
        'A camera has ViewVisibility',
        'viewVisibilityPlugin',
        'it hides nothing',
      )
  })
}
