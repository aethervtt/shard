import { allComponents, ChildOf, type JsonSchema } from '@shard/core'
import { StandardMaterial } from '@shard/render'
import { SCENE_VERSION } from './format'
import { PROCEDURAL_MESHES } from './procedural'

/**
 * JSON Schema for scene files, composed from every defined component's schema. Written to
 * `.shard/schemas/scene.schema.json` so editors and agents validate while writing.
 */
export function sceneJsonSchema(): JsonSchema {
  const components: Record<string, JsonSchema> = {}
  for (const def of allComponents()) {
    if (!def.serializable || def === ChildOf) continue
    const schema = def.jsonSchema()
    delete schema.$schema
    if (def.name === 'core/Transform') {
      const props = schema.properties as Record<string, JsonSchema>
      props.rotationEuler = {
        type: 'array',
        items: { type: 'number' },
        minItems: 3,
        maxItems: 3,
        description: 'Authoring alternative to rotation: degrees, applied X then Y then Z.',
      }
      schema.not = { required: ['rotation', 'rotationEuler'] }
    }
    components[def.name] = schema
  }
  const material = StandardMaterial.jsonSchema()
  delete material.$schema
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Shard scene',
    type: 'object',
    required: ['version', 'entities'],
    additionalProperties: false,
    properties: {
      $schema: { type: 'string' },
      version: { const: SCENE_VERSION },
      assets: {
        type: 'object',
        additionalProperties: {
          oneOf: [
            {
              type: 'object',
              properties: { type: { const: 'Material' }, value: material },
              required: ['type', 'value'],
              additionalProperties: false,
            },
            {
              type: 'object',
              properties: {
                type: { const: 'Mesh' },
                procedural: { enum: Object.keys(PROCEDURAL_MESHES) },
                params: { type: 'object', additionalProperties: { type: 'number' } },
              },
              required: ['type', 'procedural'],
              additionalProperties: false,
            },
          ],
        },
      },
      resources: { type: 'object', additionalProperties: { type: 'object' } },
      entities: { type: 'array', items: { $ref: '#/$defs/entity' } },
    },
    $defs: {
      entity: {
        type: 'object',
        required: ['name'],
        additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 1, pattern: '^[^/]+$' },
          components: { type: 'object', properties: components, additionalProperties: false },
          children: { type: 'array', items: { $ref: '#/$defs/entity' } },
        },
      },
    },
  }
}
