import { NODE_DEFS, type ParamDef } from './nodes'

function paramSchema(p: ParamDef): Record<string, unknown> {
  const base = { description: p.description }
  switch (p.type) {
    case 'input':
      return { ...base, $ref: '#/definitions/input' }
    case 'number':
      return {
        ...base,
        type: 'number',
        ...(p.default !== undefined ? { default: p.default } : {}),
        ...(p.min !== undefined ? { minimum: p.min } : {}),
        ...(p.max !== undefined ? { maximum: p.max } : {}),
        ...(p.positive ? { exclusiveMinimum: 0 } : {}),
      }
    case 'integer':
      return {
        ...base,
        type: 'integer',
        ...(p.default !== undefined ? { default: p.default } : {}),
        ...(p.min !== undefined ? { minimum: p.min } : {}),
        ...(p.max !== undefined ? { maximum: p.max } : {}),
      }
    case 'boolean':
      return {
        ...base,
        type: 'boolean',
        ...(p.default !== undefined ? { default: p.default } : {}),
      }
    case 'enum':
      return {
        ...base,
        enum: [...p.values],
        ...(p.default !== undefined ? { default: p.default } : {}),
      }
    case 'pair':
      return {
        ...base,
        type: 'array',
        items: { type: 'number' },
        minItems: 2,
        maxItems: 2,
        ...(p.default ? { default: [...p.default] } : {}),
      }
    case 'vec':
      return {
        ...base,
        anyOf: [
          { type: 'number' },
          { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 4 },
        ],
        ...(p.default !== undefined ? { default: p.default } : {}),
      }
    case 'points':
      return {
        ...base,
        type: 'array',
        minItems: 2,
        items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
      }
  }
}

/** `.shard/schemas/noise.schema.json`, generated from the node table. */
export function noiseJsonSchema(): Record<string, unknown> {
  const nodes: Record<string, unknown>[] = []
  for (const def of NODE_DEFS) {
    let body: Record<string, unknown>
    if (def.form === 'value') body = { type: 'number' }
    else if (def.form === 'list')
      body = { type: 'array', minItems: 2, items: { $ref: '#/definitions/input' } }
    else {
      const properties: Record<string, unknown> = {}
      const required: string[] = []
      for (const [name, p] of Object.entries(def.params)) {
        properties[name] = paramSchema(p)
        if (p.type === 'input' || p.type === 'points') required.push(name)
      }
      const object = {
        type: 'object',
        properties,
        additionalProperties: false,
        ...(required.length ? { required } : {}),
      }
      body = def.form === 'unary' ? { anyOf: [{ $ref: '#/definitions/input' }, object] } : object
    }
    nodes.push({
      type: 'object',
      description: `${def.description} Range: ${def.range}.`,
      properties: { [def.name]: { ...body, description: def.description } },
      required: [def.name],
      additionalProperties: false,
      examples: [def.example],
    })
  }
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'Noise graph',
    description:
      'A noise graph (*.noise.json): named nodes, and `output` naming the one the graph returns. The CPU kernel and the generated WGSL both evaluate it; seeds per source mix with the seed it is sampled with.',
    type: 'object',
    properties: {
      $schema: { type: 'string' },
      description: { type: 'string', description: 'What the graph is for.' },
      output: { type: 'string', description: 'The node the graph returns.' },
      dimensions: {
        enum: [2, 3, 4],
        default: 3,
        description: 'Domain dimensions. 4 adds a w coordinate (animated or looping noise).',
      },
      extent: {
        type: 'number',
        exclusiveMinimum: 0,
        description:
          'Largest distance from the origin the graph is sampled at (a planet radius). The importer rejects frequencies too fine to address at that distance (noise/frequency-too-high).',
      },
      nodes: {
        type: 'object',
        minProperties: 1,
        additionalProperties: { $ref: '#/definitions/node' },
      },
    },
    required: ['output', 'nodes'],
    additionalProperties: false,
    definitions: {
      input: {
        description: 'A node name, an inline node, or a number.',
        anyOf: [{ type: 'string' }, { type: 'number' }, { $ref: '#/definitions/node' }],
      },
      node: { anyOf: [{ type: 'number' }, ...nodes] },
    },
  }
}
