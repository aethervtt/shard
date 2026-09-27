import type { JsonSchema } from '@aethervtt/shard-core'
import { allGenerators } from './generator'

/**
 * `.shard/schemas/gen.schema.json`: generator files, with `params` checked against the schema of
 * the generator the file names (one branch per generator).
 */
export function genFileSchema(): JsonSchema {
  const gens = allGenerators()
  const base: JsonSchema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'Shard generator file (*.gen.json)',
    description:
      'A generator, a seed, and params. Imports as the generator output (a mesh, texture, data value, or prefab-shaped entities).',
    type: 'object',
    required: ['generator'],
    properties: {
      $schema: { type: 'string' },
      generator: {
        type: 'string',
        description: 'The generator, by name.',
        ...(gens.length ? { enum: gens.map((g) => g.name) } : {}),
      },
      seed: { type: 'integer', minimum: 0, maximum: 4294967295, default: 0 },
      params: { type: 'object' },
    },
    additionalProperties: false,
  }
  if (gens.length === 0) return base
  return {
    ...base,
    oneOf: gens.map((g) => ({
      properties: {
        generator: { const: g.name },
        params: { ...g.params.jsonSchema(), description: g.description ?? `${g.name} params.` },
      },
    })),
  }
}
