import { allComponents, ChildOf, type JsonSchema } from '@shard/core'
import { StandardMaterial } from '@shard/render'
import { PREFAB_VERSION, SCENE_VERSION } from './format'
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

/**
 * JSON Schema for prefab files: a root entity (the scene schema's entity), or a variant with
 * "extends", "rootComponents", "overrides", and "children". Written to `.shard/schemas/`.
 */
export function prefabJsonSchema(): JsonSchema {
  const scene = sceneJsonSchema()
  const props = scene.properties as Record<string, JsonSchema>
  const components = { $ref: '#/$defs/entity/properties/components' }
  const patch = { anyOf: [{ type: 'null' }, { type: 'object' }] }
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Shard prefab',
    type: 'object',
    required: ['version'],
    additionalProperties: false,
    properties: {
      $schema: { type: 'string' },
      version: { const: PREFAB_VERSION },
      assets: props.assets!,
      root: { $ref: '#/$defs/entity' },
      extends: {
        type: 'object',
        description: 'Variants: the base prefab, e.g. { "path": "prefabs/ship.prefab.json" }.',
        properties: { guid: { type: 'string' }, path: { type: 'string' } },
        additionalProperties: false,
        minProperties: 1,
      },
      rootComponents: {
        ...components,
        description: "Variants: fields set on the base's root components (added if missing).",
      },
      overrides: {
        type: 'object',
        description:
          'Variants: changes to the base\'s entities by path from the root. { "Hull": { "<component>": { fields } } } sets fields, { "Hull/Antenna": null } removes an entity, { "Hull/<component>": null } removes a component.',
        additionalProperties: {
          anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: patch }],
        },
      },
      children: {
        type: 'array',
        description: 'Variants: extra children under the root.',
        items: { $ref: '#/$defs/entity' },
      },
    },
    oneOf: [{ required: ['root'] }, { required: ['extends'] }],
    $defs: scene.$defs,
  }
}
