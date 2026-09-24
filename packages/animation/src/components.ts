import { AssetStore, defineAssetType, defineDataAsset, type LoadContext } from '@shard/assets'
import {
  defineComponent,
  defineEvent,
  defineResource,
  defineSchema,
  type Entity,
  type Infer,
  type JsonValue,
  ShardError,
  t,
} from '@shard/core'
import { Transform } from '@shard/transform'

// --- masks -----------------------------------------------------------------------------------

export const AnimationMaskSchema = defineSchema(
  'animation/AnimationMask',
  {
    joints: t.json({
      default: {},
      description:
        'Weights by entity path under the player. A path covers its subtree; the longest matching path wins; paths no entry covers get 0. { "Armature/Hips/Spine": 1, "Armature/Hips/Spine/Neck": 0 }',
    }),
  },
  { description: 'Which parts of a body a layer animates (*.mask.json).' },
)

export interface AnimationMaskAsset {
  /** Weight by path. */
  joints: Record<string, number>
}

export const AnimationMasks = defineResource<AssetStore<AnimationMaskAsset, 'AnimationMask'>>(
  'animation/AnimationMasks',
  { description: 'Animation masks by guid.', init: () => new AssetStore('AnimationMask') },
)

function loadMask(json: JsonValue | undefined, _ctx?: LoadContext): AnimationMaskAsset {
  const joints = ((json as { joints?: unknown } | undefined)?.joints ?? {}) as Record<
    string,
    unknown
  >
  const out: Record<string, number> = {}
  for (const [path, w] of Object.entries(joints)) {
    if (typeof w !== 'number' || w < 0 || w > 1) {
      throw new ShardError('animation/invalid-mask', `Mask weight for "${path}" must be 0 to 1`, {
        path: `/joints/${path.replace(/~/g, '~0').replace(/\//g, '~1')}`,
      })
    }
    out[path] = w
  }
  return { joints: out }
}

export const AnimationMaskAssetType = defineAssetType<AnimationMaskAsset>('AnimationMask', {
  store: AnimationMasks,
  load: (artifact, ctx) => loadMask(artifact.json, ctx),
  update: (existing, next) => {
    existing.joints = next.joints
  },
})

/** `*.mask.json` files import as AnimationMask. */
export const MaskImporter = defineDataAsset('AnimationMask', AnimationMaskSchema, {
  extension: 'mask',
})

/**
 * A mask's weight for a path: the longest mask entry that is the path or one of its ancestors, or
 * 0 when none covers it.
 */
export function maskWeight(mask: AnimationMaskAsset, path: string): number {
  let best = -1
  let weight = 0
  for (const key in mask.joints) {
    const covers = key === '' || path === key || path.startsWith(`${key}/`)
    if (covers && key.length > best) {
      best = key.length
      weight = mask.joints[key]!
    }
  }
  return weight
}

// --- the player ------------------------------------------------------------------------------

export const LOOP_MODES = ['loop', 'once', 'ping-pong'] as const
export const BLEND_MODES = ['override', 'additive'] as const
export const ROOT_MOTION_MODES = ['none', 'transform', 'character'] as const

export const AnimationLayer = t.struct({
  clip: t.handle('AnimationClip', { description: 'The clip: glTF animation or .anim.json.' }),
  time: t.f32({ unit: 's', description: 'Playback position. Loops wrap it; once clamps it.' }),
  speed: t.f32({ default: 1, description: 'Playback rate (negative plays backward).' }),
  weight: t.f32({
    default: 1,
    min: 0,
    max: 1,
    description:
      'How much this layer counts: override lerps toward its pose, additive scales its delta.',
  }),
  loop: t.enum(LOOP_MODES, {
    description:
      'loop: wraps. once: holds the last pose, then AnimationFinished. ping-pong: back and forth.',
  }),
  blend: t.enum(BLEND_MODES, {
    description:
      "override: blends toward this layer's pose. additive: adds its change since the clip's first frame.",
  }),
  mask: t.handle('AnimationMask', {
    description:
      'Only these parts of the body (a *.mask.json). None: everything the clip animates.',
  }),
  playing: t.bool({
    default: true,
    description: 'Advance time. Paused layers still hold their pose.',
  }),
  fadeTo: t.f32({
    default: 1,
    min: 0,
    max: 1,
    description: 'The weight a fade moves toward. A layer faded to 0 is removed.',
  }),
  fadeSpeed: t.f32({
    min: 0,
    description: 'Weight per second toward fadeTo (0: no fade). crossfade() sets both.',
  }),
})

export const RootMotion = defineComponent(
  'animation/RootMotion',
  {
    translation: t.vec3({
      unit: 'm',
      readonly: true,
      description: "This frame's root travel on the ground plane, in the entity's local frame.",
    }),
    rotation: t.quat({ readonly: true, description: "This frame's root turn (yaw)." }),
  },
  {
    description:
      'Root motion taken out of the pose this frame (AnimationPlayer.rootMotion). Written by animation; read it to move things yourself.',
    serialize: false,
  },
)

export const AnimationPlayer = defineComponent(
  'animation/AnimationPlayer',
  {
    layers: t.list(AnimationLayer, {
      description:
        "Clips playing on this entity's hierarchy, blended in order: each override layer lerps (slerps rotations) toward its pose by weight; additive layers add their delta.",
    }),
    rootMotion: t.enum(ROOT_MOTION_MODES, {
      description:
        'none: the root joint moves as authored. transform: its ground-plane travel and yaw move this entity instead. character: they feed physics/CharacterIntent.move, so walking collides.',
    }),
    rootJoint: t.string({
      description:
        'Path of the joint root motion comes from. Empty: the highest joint a translation channel animates.',
    }),
  },
  {
    description:
      "Plays animation clips on this entity and the entities under it (joints by path), and on any numeric component field (property clips). Put it on the model's root, e.g. the SceneInstance entity.",
    requires: [Transform, RootMotion],
  },
)

export type AnimationPlayerValue = Infer<typeof AnimationPlayer>
export type AnimationLayerValue = AnimationPlayerValue['layers'][number]

export interface AnimationFinishedData {
  entity: Entity
  layer: number
}

export const AnimationFinished = defineEvent<AnimationFinishedData>('animation/AnimationFinished', {
  description: 'A once layer reached its end (it holds the last pose).',
})

export interface AnimationEventData {
  entity: Entity
  layer: number
  name: string
  /** Clip time of the event. */
  time: number
  data: JsonValue | undefined
}

export const AnimationEvent = defineEvent<AnimationEventData>('animation/AnimationEvent', {
  description: "A clip event's time was crossed (footsteps, hit frames, sounds).",
})
