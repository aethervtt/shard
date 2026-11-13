import { defineComponent, defineResource, type Infer, t } from '@aethervtt/shard-core'
import { Transform } from '@aethervtt/shard-transform'

/** Representation tiers, finest first (0115). */
export const TIERS = ['near', 'mid', 'far', 'off'] as const
export type Tier = (typeof TIERS)[number]
export const NEAR = 0
export const MID = 1
export const FAR = 2
export const OFF = 3

/** Character.look when it wasn't spawned from a registered look. */
export const NO_LOOK = 0xffff

/** Simulation tiers: by distance to the nearest player. */
export const SIM_TIERS = ['near', 'mid', 'far'] as const

export const Character = defineComponent(
  'characters/Character',
  {
    rig: t.string({ description: 'The CharacterRig this character is built on, by name.' }),
    build: t.u16({
      description: "Index of the rig's build (palette entry); 0 is the plain skeleton.",
    }),
    look: t.u16({
      default: 0xffff,
      description:
        'Index of a registered look (characterLooks) it was spawned from, or 65535 for none. A replicated root with a look is composed on arrival.',
    }),
  },
  {
    description:
      'A character composed of parts on a shared skeleton (0115). Spawned by spawnCharacter; its parts are children with CharacterPart.',
    requires: [Transform],
  },
)

export const CharacterTier = defineComponent(
  'characters/CharacterTier',
  {
    tier: t.enum(TIERS, {
      readonly: true,
      description:
        'near: joint entities, graph, IK. mid: pose sampled into a pose buffer, no joints. far: baked clips played on the GPU. off: not drawn or sampled.',
    }),
    sim: t.enum(SIM_TIERS, {
      readonly: true,
      description:
        'By distance to the nearest player (TierSource.player): what game AI and movement use.',
    }),
    simTick: t.bool({
      readonly: true,
      description:
        "True on frames this character's sim period comes due (staggered). Tick game AI on it.",
    }),
    pin: t.bool({
      description:
        'Keep it near whatever the caps say (a player: first person needs its rig and IK). Pinned characters never count toward maxNear.',
    }),
    screen: t.f32({
      readonly: true,
      description:
        "Largest screen size over the viewers: the sphere's diameter over the viewport height.",
    }),
  },
  { description: "A character's representation and simulation tiers (0115).", serialize: false },
)

export const CharacterPart = defineComponent(
  'characters/CharacterPart',
  {
    name: t.string({
      description: "The part's node name in its model (body-head, eyes, a worn item).",
    }),
    minTier: t.enum(TIERS, {
      default: 'off',
      description: 'The coarsest tier that draws this part (eyelashes: near).',
    }),
    merged: t.bool({
      description: "The rig's merged far body (drawn at far instead of far.merge parts).",
    }),
  },
  { description: 'One skinned mesh of a character.', serialize: false },
)

export const TierSource = defineComponent(
  'characters/TierSource',
  {
    viewer: t.bool({ description: 'A camera whose view chooses representation tiers.' }),
    player: t.bool({ description: 'A player whose distance chooses simulation tiers.' }),
  },
  { description: 'What tiers are measured from (0115): viewer cameras and players.' },
)

export interface TierBudgetValue {
  /** Unpinned characters at near at most. */
  maxNear: number
  /** Characters at mid at most. */
  maxMid: number
  /** Unpinned characters entering near in one frame at most; the rest wait at mid. */
  joinsPerFrame: number
  /** Fraction past a threshold before a tier changes. */
  hysteresis: number
  /** Seconds between two changes of one character's tier (entering or leaving off is immediate). */
  dwell: number
  /** Seconds IK takes to fade in on entering near, and out before leaving it. */
  ikFade: number
  /** Sim tier thresholds (m) to the nearest player. */
  simNear: number
  simMid: number
  /** Frames between simTicks, per sim tier. */
  simEvery: [number, number, number]
  /** Whether a headless app gives out rigs (hit detection, sockets). */
  serverRigs: boolean
}

export const TierBudget = defineResource<TierBudgetValue>('characters/TierBudget', {
  description: 'Caps, hysteresis and rates for character tiers (0115).',
  init: () => ({
    maxNear: 16,
    maxMid: 160,
    joinsPerFrame: 4,
    hysteresis: 0.15,
    dwell: 0.3,
    ikFade: 0.2,
    simNear: 30,
    simMid: 80,
    simEvery: [1, 4, 15],
    serverRigs: false,
  }),
})

export type CharacterTierValue = Infer<typeof CharacterTier>
