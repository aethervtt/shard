import { defineDataType } from '@aethervtt/shard-assets'
import { type Infer, ShardError, t } from '@aethervtt/shard-core'

/** Branch levels a species can have: the trunk and up to three levels of branches. */
export const MAX_TREE_LEVELS = 4

const billboard = (description: string) =>
  t.enum(['single', 'double'], { default: 'double', description })

const level = t.struct({
  length: t.f32({
    default: 4,
    min: 0,
    unit: 'm',
    description:
      'Length of a branch of this level (evergreen branches shorten toward the top of their parent).',
  }),
  radius: t.f32({
    default: 0.7,
    min: 0,
    description:
      'The trunk: its radius at the ground, in metres. Other levels: a fraction of the parent’s radius where the branch starts.',
  }),
  angle: t.f32({
    default: 60,
    min: 0,
    max: 180,
    unit: 'deg',
    description: 'Angle between a branch and its parent (unused for the trunk).',
  }),
  children: t.u8({
    default: 5,
    max: 128,
    description:
      'Branches of the next level grown from each branch of this one (unused at the last level).',
  }),
  start: t.f32({
    default: 0.3,
    min: 0,
    max: 1,
    description: 'Where along its parent this level’s branches start growing (0 base, 1 tip).',
  }),
  gnarliness: t.f32({
    default: 0.2,
    description:
      'Random bend per section, larger on thin branches. Negative values bend the other way.',
  }),
  taper: t.f32({
    default: 0.7,
    min: 0,
    max: 1,
    description: 'How much thinner a branch is at its tip than at its base (deciduous only).',
  }),
  twist: t.f32({ default: 0, unit: 'rad', description: 'Twist per section about the branch.' }),
  sections: t.u8({
    default: 8,
    min: 1,
    description: 'Rings along a branch: more bends, more triangles.',
  }),
  segments: t.u8({ default: 6, min: 3, max: 64, description: 'Sides around a branch.' }),
})

/** A struct field's default with some fields changed: list defaults are used as given. */
function at<V>(field: { defaultValue(): V }, patch: Partial<V>): V {
  return { ...field.defaultValue(), ...patch }
}

const lod = t.struct({
  sectionStride: t.u8({
    default: 3,
    min: 1,
    description: 'Keeps every nth ring of a branch (its first and last always stay).',
  }),
  segmentFactor: t.f32({
    default: 0.75,
    min: 0,
    max: 1,
    description: 'Fraction of the sides kept around a branch (at least 3).',
  }),
  leafStride: t.u8({ default: 2, min: 1, description: 'Keeps every nth leaf.' }),
  leafScale: t.f32({
    default: 1.25,
    min: 0,
    description: 'Scales the kept leaves, so a thinned canopy still covers about as much.',
  }),
  billboard: billboard('Leaf cards: one quad, or two crossed.'),
})

export const TreeSpeciesFields = {
  form: t.enum(['deciduous', 'evergreen'], {
    default: 'deciduous',
    description:
      'deciduous: each branch also continues from its tip into the next level, for a rounded crown. evergreen: branches taper to a point and shorten up the trunk, for a cone.',
  }),
  levels: t.list(level, {
    default: [
      at(level, {
        length: 4,
        radius: 0.3,
        sections: 12,
        segments: 8,
        gnarliness: 0.15,
        children: 7,
      }),
      at(level, { length: 4, angle: 70, children: 7, start: 0.4, gnarliness: 0.2, sections: 10 }),
      at(level, { length: 2, angle: 60, children: 5, gnarliness: 0.3, segments: 4 }),
      at(level, { length: 0.2, angle: 60, gnarliness: 0.02, sections: 6, segments: 3 }),
    ],
    description: `The trunk first, then each level of branches (1 to ${MAX_TREE_LEVELS}).`,
  }),
  force: t.struct(
    {
      direction: t.vec3({
        default: [0, 1, 0],
        description: 'Direction branches bend toward as they grow (away with a negative strength).',
      }),
      strength: t.f32({
        default: 0.01,
        description: 'How hard they bend, more on thin branches.',
      }),
    },
    { description: 'A growth force: light, gravity, wind-bent trees.' },
  ),
  bark: t.struct({
    textureScale: t.vec2({
      default: [5, 1],
      description:
        'x: times the bark texture wraps around a branch per metre of its radius (at least once). y: stretch along the branch (1 keeps texels square).',
    }),
  }),
  leaves: t.struct({
    count: t.u8({ default: 1, max: 128, description: 'Leaves per branch of the last level.' }),
    start: t.f32({
      default: 0,
      min: 0,
      max: 1,
      description: 'Where along a branch leaves start (0 base, 1 tip).',
    }),
    angle: t.f32({
      default: 10,
      min: 0,
      max: 180,
      unit: 'deg',
      description: 'Angle between a leaf and its branch.',
    }),
    size: t.f32({
      default: 0.5,
      min: 0,
      unit: 'm',
      description: 'Width and length of a leaf card.',
    }),
    sizeVariance: t.f32({
      default: 0.7,
      min: 0,
      max: 1,
      description: 'Random size change per leaf, as a fraction of size.',
    }),
    billboard: billboard('Leaf cards: one quad, or two crossed (fuller from every side).'),
    roundedNormals: t.bool({
      default: true,
      description:
        'Normals that point out of each card’s centre, so the canopy shades as one rounded volume.',
    }),
  }),
  lods: t.list(lod, {
    default: [
      at(lod, { sectionStride: 3, segmentFactor: 0.75, leafStride: 2, leafScale: 1.25 }),
      at(lod, {
        sectionStride: 6,
        segmentFactor: 0.4,
        leafStride: 2,
        leafScale: 1.3,
        billboard: 'single',
      }),
    ],
    description: 'Lower levels of detail, meshed from the same tree (LOD1 first).',
  }),
}

/**
 * A tree's shape as data (spec 0095): `*.tree.json`. The `nature/Tree` generator grows one from a
 * species and a seed. Look (bark and leaf textures, tints) is the material's, so one species can be
 * drawn several ways.
 */
export const TreeSpecies = defineDataType('nature/TreeSpecies', TreeSpeciesFields, {
  extension: 'tree',
  description:
    'A procedural tree species: branch levels (length, radius, angle, children, bends), a growth force, leaves, and levels of detail. nature/Tree grows one per seed.',
  validate: (value) => validateSpecies(value as TreeSpeciesValue),
})

export type TreeSpeciesValue = Infer<typeof TreeSpecies>

/** Structural checks the schema can't express. Throws `nature/bad-species`. */
export function validateSpecies(species: TreeSpeciesValue): void {
  const n = species.levels.length
  if (n < 1 || n > MAX_TREE_LEVELS) {
    throw new ShardError(
      'nature/bad-species',
      `A species has 1 to ${MAX_TREE_LEVELS} levels (the trunk and its branches), got ${n}`,
      {
        path: '/levels',
        hint: 'levels[0] is the trunk; each further entry is a level of branches.',
      },
    )
  }
  const d = species.force.direction
  if (d[0] === 0 && d[1] === 0 && d[2] === 0 && species.force.strength !== 0) {
    throw new ShardError('nature/bad-species', 'The growth force has no direction', {
      path: '/force/direction',
      hint: 'Use [0, 1, 0] to grow toward the sky, or set strength to 0.',
    })
  }
}
