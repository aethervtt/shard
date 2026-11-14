import {
  defineComponent,
  defineEvent,
  defineResource,
  type Entity,
  type Infer,
  t,
} from '@aethervtt/shard-core'

export const DRIVES = ['auto', 'game'] as const
export const REACTION_STATES = ['none', 'partial', 'down', 'rested', 'getting-up', 'dead'] as const
export type ReactionState = (typeof REACTION_STATES)[number]
export const HIT_KINDS = ['auto', 'partial', 'knockdown', 'death'] as const
export type HitKind = (typeof HIT_KINDS)[number]

export const NONE = 0
export const PARTIAL = 1
export const DOWN = 2
export const RESTED = 3
export const GETTING_UP = 4
export const DEAD = 5

export const Ragdoll = defineComponent(
  'ragdoll/Ragdoll',
  {
    asset: t.handle('Ragdoll', {
      description: 'The *.ragdoll.json: bodies, limits, rests, roles.',
    }),
    drive: t.enum(DRIVES, {
      description:
        'auto: the reaction plays role clips, the rest pose and the get-up, and moves the root along their travel. game: it stops at rested, plays no clip and moves no root; the game does, and calls stand().',
    }),
    profile: t.string({
      default: 'default',
      description: 'The drive profile partial reactions use.',
    }),
  },
  {
    description:
      'Makes a root take hits and react (0117): any root, a Shard character or a plain replicated entity whose model exists only on clients.',
  },
)

export const Reaction = defineComponent(
  'ragdoll/Reaction',
  {
    state: t.enum(REACTION_STATES, {
      readonly: true,
      description:
        'none; partial (nearby bones react, the rest animates); down (falling, full ragdoll); rested (lying in its rest); getting-up; dead.',
    }),
    since: t.f64({
      readonly: true,
      unit: 's',
      description: 'Time the state began (Time.elapsed).',
    }),
    stagger: t.f32({
      readonly: true,
      description: 'Accumulated hits toward a knockdown: 1 knocks it down. Decays over time.',
    }),
    bone: t.u8({ readonly: true, description: 'The body last hit (index in the asset).' }),
    rest: t.u8({
      readonly: true,
      description: 'The rest it lies in (index in the asset’s rests).',
    }),
    role: t.u8({
      readonly: true,
      description:
        'The clip role the last hit picked (index in the asset’s sorted roles), 255 none.',
    }),
    impulse: t.vec3({
      readonly: true,
      unit: 'N·s',
      description: 'The last hit’s impulse, or its launch velocity (m/s) when launch is set.',
    }),
    launch: t.bool({ readonly: true, description: 'The last hit was a launch (a car).' }),
    seq: t.u16({
      readonly: true,
      description: 'Counts hits: a client starts a reaction when it changes.',
    }),
  },
  { description: 'What a ragdoll root is going through (0117). Game AI reads it.' },
)

/** A pooled ragdoll body. Internal; not saved. */
export const RagdollBody = defineComponent(
  'ragdoll/RagdollBody',
  {
    root: t.entity({ description: 'The root it is simulating for, or none while pooled.' }),
    body: t.u8({ description: 'Its index in the asset.' }),
  },
  { description: 'A ragdoll’s rigid body (0117).', serialize: false },
)

export interface RagdollBudgetValue {
  /** Ragdolls simulated at once. */
  maxActive: number
  /** Frozen corpses kept before the oldest is evicted (CorpseEvicted). */
  maxCorpses: number
  /** Screen size below which a hit plays clips only. */
  promoteScreen: number
  /** Seconds the physics takes to blend in, from 0. */
  blendIn: number
  /** Seconds from the ragdoll to the rest pose. */
  restBlend: number
  /** Seconds IK takes to fade out while full. */
  ikFade: number
  /** Seconds after which a dead ragdoll freezes, settled or not. */
  corpseAfter: number
  /** Whether character capsules collide with ragdoll bodies. Set before characters spawn. */
  blockCharacters: boolean
  /** Extra solver iterations for ragdoll bodies: Rapier's default 4 lets joint limits stretch. */
  solverIterations: number
}

export const RagdollBudget = defineResource<RagdollBudgetValue>('ragdoll/Budget', {
  description: 'Caps and timings for simulated ragdolls (0117).',
  init: () => ({
    maxActive: 24,
    maxCorpses: 200,
    promoteScreen: 0.05,
    blendIn: 0.05,
    restBlend: 0.5,
    ikFade: 0.15,
    corpseAfter: 6,
    blockCharacters: false,
    solverIterations: 12,
  }),
})

export interface ReactionStartedData {
  entity: Entity
  kind: ReactionState
  /** The hit body's joint name, and its zone. */
  bone: string
  zone: string
  /** The clip role picked, or '' for none. */
  role: string
}

export const ReactionStarted = defineEvent<ReactionStartedData>('ragdoll/ReactionStarted', {
  description: 'A hit started (or upgraded) a reaction.',
})
export const KnockedDown = defineEvent<{ entity: Entity; rest: string }>('ragdoll/KnockedDown', {
  description: 'A root went down; it will lie in `rest`.',
})
export const Rested = defineEvent<{ entity: Entity; rest: string }>('ragdoll/Rested', {
  description: 'A downed root lies in its rest: with drive game, the game takes over here.',
})
export const GotUp = defineEvent<{ entity: Entity }>('ragdoll/GotUp', {
  description: 'A root is standing again.',
})
export const CorpseSettled = defineEvent<{ entity: Entity }>('ragdoll/CorpseSettled', {
  description: 'A dead ragdoll froze into its final pose.',
})
export const CorpseEvicted = defineEvent<{ entity: Entity }>('ragdoll/CorpseEvicted', {
  description: 'Past maxCorpses: the oldest corpse. Despawning it is the game’s call.',
})

export type RagdollValue = Infer<typeof Ragdoll>
export type ReactionValue = Infer<typeof Reaction>
