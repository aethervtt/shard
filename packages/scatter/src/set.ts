import { defineDataType } from '@aethervtt/shard-assets'
import { t } from '@aethervtt/shard-core'

/** Collider shapes a prop rule can give its items (fixed bodies; none by default). */
export const PROP_COLLIDERS = ['none', 'convex', 'trimesh', 'ball', 'cuboid'] as const
export type PropCollider = (typeof PROP_COLLIDERS)[number]

const item = t.struct({
  prefab: t.handle('Prefab', {
    description: 'A prefab to place (its root gets the placement transform). Or use generator.',
  }),
  generator: t.string({
    description:
      'A mesh generator by name: "shard/Rock", "shard/Tree", "shard/Bush", "shard/GrassClump", "shard/Crystal", or a project’s ("star-explorer/Rock").',
  }),
  params: t.json({ description: 'The generator’s params (missing ones take its defaults).' }),
  variants: t.u8({
    default: 1,
    min: 1,
    max: 32,
    description:
      'Distinct meshes generated (seeds are the rule’s child seeds 0 … n−1); each placement picks one. 4–8 read as unique once scaled and rotated.',
  }),
  material: t.handle('Material', {
    description:
      'The generator item’s material (default: scatter/Vegetation tinted for the generator).',
  }),
  weight: t.f32({
    default: 1,
    min: 0,
    description: 'Relative chance among the rule’s items.',
  }),
  radius: t.f32({
    min: 0,
    unit: 'm',
    description:
      'Footprint radius for `avoid` and `sink` before scale (0: from the mesh’s bounds; prefabs: half the rule’s spacing).',
  }),
})

const range = (what: string, unit: string, typical: string) =>
  t.vec2({
    unit,
    description: `[min, max] ${what}. Equal ends (the default): anywhere. ${typical}`,
  })

const rule = t.struct({
  name: t.string({
    required: true,
    description: 'Unique in the set: `avoid` lists, saves, and scatter.describe use it.',
  }),
  kind: t.enum(['prop', 'foliage'], {
    description:
      'prop: entities (colliders, saves, gameplay), a few thousand near the player. foliage: GPU instances only (grass, flowers), millions, no entities.',
  }),
  items: t.list(item, { description: 'What it places, picked by weight.' }),
  density: t.f32({
    default: 0.01,
    min: 0,
    unit: '1/m²',
    description:
      'Items per square metre where the masks pass. Typical: boulders 0.002–0.01, trees 0.005–0.05, bushes 0.02–0.1, grass 4–10, flowers 0.5–2.',
  }),
  spacing: t.f32({
    min: 0,
    unit: 'm',
    description:
      'Least distance between two items of this rule (0: none). Typical: about an item’s diameter (trees 3–6, boulders 4–8).',
  }),
  masks: t.struct(
    {
      slope: range('slope', 'deg', 'Grass 0–25, trees 0–30, boulders 0–35, cliff rocks 35–90.'),
      height: range(
        'height',
        'm',
        'Metres above the planet radius (a mesh surface: its local y). Beaches −2–4, treeline below 1 200.',
      ),
      noise: t.struct(
        {
          graph: t.handle('NoiseGraph', {
            description: 'A noise graph (*.noise.json) sampled where items would go.',
          }),
          above: t.f32({
            description:
              'Items only where the graph’s value is above this (−1 to 1). 0.2 makes patches.',
          }),
        },
        { description: 'Patches: items only where a noise graph is above a threshold.' },
      ),
    },
    { description: 'Where items may go, on top of the biome the set belongs to.' },
  ),
  align: t.f32({
    min: 0,
    max: 1,
    description:
      'Up axis from world up (0, radial on a planet) to the surface normal (1). Trees 0, rocks 0.6–1, grass 0.3.',
  }),
  scale: t.vec2({
    default: [1, 1],
    min: 0,
    description: 'Uniform scale range [min, max] per item. Typical [0.7, 1.4].',
  }),
  sink: t.f32({
    min: 0,
    max: 1,
    description: 'Pushes items into the ground by this fraction of their height. Rocks 0.1–0.3.',
  }),
  collider: t.enum(PROP_COLLIDERS, {
    description:
      'Props: a fixed collider from the item’s coarsest mesh (convex, trimesh) or its bounds (ball, cuboid). Foliage ignores it.',
  }),
  range: t.f32({
    default: 200,
    min: 1,
    unit: 'm',
    description:
      'Distance from the camera (or a TerrainAnchor, for props) at which items exist. Grass 40–80, bushes 100–200, trees 300–800, boulders 300–600.',
  }),
  avoid: t.list(t.string, {
    description:
      'Earlier rules whose items keep this one out of their footprint (by the placed item’s radius): ["boulders"] keeps grass off rocks.',
  }),
  wind: t.f32({
    default: 1,
    min: 0,
    description: 'Foliage: how much the wind sways it (0 rigid, 1 grass).',
  }),
  shadowRange: t.f32({
    default: 30,
    min: 0,
    unit: 'm',
    description: 'Foliage: casts shadows within this distance of the camera (0: never).',
  }),
})

/**
 * Rules that place props and foliage on a surface (spec 0045): a planet everywhere
 * (`Planet.scatter`), a planet's biome where it dominates (`Biome.scatter`), or a mesh
 * (`scatter/ScatterSurface`). Rule order is priority: `avoid` names earlier rules.
 */
export const ScatterSet = defineDataType(
  'scatter/ScatterSet',
  {
    rules: t.list(rule, { description: 'Placement rules, highest priority first.' }),
    seed: t.u32({ description: 'Mixed into every rule’s seed: the same rules, new places.' }),
  },
  {
    extension: 'scatter',
    description:
      'Scatter rules: props (entities) and foliage (GPU instances) placed by density, spacing, masks, alignment, and random transforms, the same on every visit and machine.',
  },
)

export type ScatterSetValue = ReturnType<typeof ScatterSet.defaults>
export type ScatterRuleValue = ScatterSetValue['rules'][number]
export type ScatterItemValue = ScatterRuleValue['items'][number]
