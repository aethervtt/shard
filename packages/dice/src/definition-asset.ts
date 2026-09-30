import { defineDataType } from '@aethervtt/shard-assets'
import { type Infer, t } from '@aethervtt/shard-core'
import type { DieDefinition } from './definition'

// Die definitions as data assets (0054): `data/**/*.die.json`, for hosts that describe their own
// dice in files. Loaded values become definitions with `dieDefinitionOf`, then `defineDie`.

export const DieDefinitionAsset = defineDataType(
  'dice/DieDefinition',
  {
    version: t.u8({ default: 1, min: 1, max: 1, description: 'Format version: 1.' }),
    id: t.string({ description: "'d20', 'd10-tens', 'd100-ball'." }),
    sides: t.u8({ min: 2, max: 100, description: 'How many values it shows.' }),
    vertices: t.list(t.f32(), {
      description:
        'Canonical points, x y z each, unit radius, in a fixed order: vertex ids index them.',
    }),
    read: t.enum(['face', 'vertex'], {
      description: 'The face on top reads, or (d4) the vertex on top.',
    }),
    values: t.json({
      default: {},
      description: "Value by sorted vertex ids of a face ('0:1:4:5') or by a vertex id ('3').",
    }),
    labels: t.json({
      default: {},
      description: "The printed mark per value where it isn't the value ('00').",
    }),
    collider: t.enum(['hull', 'ball'], { description: 'A hull of the vertices, or a ball.' }),
    sizeMm: t.f32({ default: 16, min: 1, unit: 'mm', description: 'Landed footprint diameter.' }),
    bevel: t.f32({
      default: 0.082,
      min: 0,
      max: 0.3,
      description: 'Chamfer toward each face center.',
    }),
    markScale: t.f32({
      default: 0.4,
      min: 0.05,
      max: 1,
      description: "Mark height, of a face's size.",
    }),
    oppositesSum: t.bool({ description: 'Opposite faces must sum to sides + 1.' }),
  },
  { extension: 'die', description: 'A die: its shape, numbering and printed labels.' },
)

export type DieDefinitionAssetValue = Infer<typeof DieDefinitionAsset>

/** The definition a `*.die.json` describes (check it with validateDieDefinition). */
export function dieDefinitionOf(value: DieDefinitionAssetValue): DieDefinition {
  return {
    version: 1,
    id: value.id,
    sides: value.sides,
    vertices: Float32Array.from(value.vertices),
    read: value.read,
    values: value.values as Record<string, number>,
    labels: value.labels as Record<number, string>,
    collider: value.collider,
    sizeMm: value.sizeMm,
    bevel: value.bevel,
    markScale: value.markScale,
    oppositesSum: value.oppositesSum,
  }
}
