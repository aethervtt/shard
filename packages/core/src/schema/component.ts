import { ShardError } from '../error'
import type { JsonObject, JsonSchema } from '../json'
import {
  type AnyField,
  defaultsOf,
  type Fields,
  type InferFields,
  objectFromJson,
  objectSchema,
  objectToJson,
  type SchemaContext,
  type Storage,
  validateObject,
} from './field'
import { allocateId, assertName } from './names'

export interface ColumnLayout {
  readonly name: string
  readonly field: AnyField
  readonly storage: Storage
  readonly stride: number
}

export interface ComponentOptions {
  description?: string
  /** Defaults to 1. Versions above 1 need `migrate`. */
  version?: number
  /** Upgrades JSON written at version `from` to version `from + 1`. */
  migrate?: (from: number, json: unknown) => unknown
  /**
   * Components added automatically (with defaults) whenever this one is added, transitively.
   * Spawning `Mesh3d` brings `Transform`, which brings `GlobalTransform`.
   */
  requires?: readonly ComponentDef[]
}

export interface ComponentDef<F extends Fields = Fields> {
  readonly kind: 'component'
  /** Process-wide numeric id, used internally by the ECS. Never serialized. */
  readonly id: number
  readonly name: string
  readonly fields: F
  readonly isTag: boolean
  readonly description: string | undefined
  readonly version: number
  /** Column descriptors, in field order. ECS tables are built from this alone. */
  readonly layout: readonly ColumnLayout[]
  /** Components added along with this one. */
  readonly requires: readonly ComponentDef[]
  defaults(): InferFields<F>
  serialize(value: InferFields<F>): JsonObject
  /** Validates, then converts. Throws the first validation error. */
  deserialize(json: unknown, ctx?: SchemaContext): InferFields<F>
  validate(json: unknown, ctx?: SchemaContext): ShardError[]
  jsonSchema(): JsonSchema
  /** Runs migrations from `fromVersion` up to the current version. */
  upgrade(json: unknown, fromVersion: number): unknown
}

export type TagDef = ComponentDef<Record<never, never>>
export type Infer<C> = C extends ComponentDef<infer F> ? InferFields<F> : never

export function defineComponent<const F extends Fields>(
  name: string,
  fields: F,
  options: ComponentOptions = {},
): ComponentDef<F> {
  assertName('component', name)
  const version = options.version ?? 1
  if (!Number.isInteger(version) || version < 1) {
    throw new ShardError('schema/invalid-version', `Component "${name}" has invalid version`, {
      hint: 'Versions are integers starting at 1.',
    })
  }
  if (version > 1 && !options.migrate) {
    throw new ShardError(
      'schema/missing-migration',
      `Component "${name}" is at version ${version} but has no migrate function`,
    )
  }

  const layout: ColumnLayout[] = Object.entries(fields).map(([fieldName, field]) => ({
    name: fieldName,
    field,
    storage: field.storage,
    stride: field.stride,
  }))

  const validate = (json: unknown, ctx?: SchemaContext) => {
    const errors: ShardError[] = []
    validateObject(fields, json, '', errors, ctx)
    return errors
  }

  return {
    kind: 'component',
    id: allocateId(),
    name,
    fields,
    isTag: layout.length === 0,
    description: options.description,
    version,
    layout,
    requires: options.requires ?? [],
    defaults: () => defaultsOf(fields),
    serialize: (value) => objectToJson(fields, value as Record<string, unknown>),
    deserialize(json, ctx) {
      const errors = validate(json, ctx)
      if (errors.length > 0) throw errors[0]
      return objectFromJson(fields, json as Record<string, unknown>, ctx)
    },
    validate,
    jsonSchema: () => {
      const schema: JsonSchema = {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        title: name,
      }
      if (options.description) schema.description = options.description
      return { ...schema, ...objectSchema(fields), 'x-version': version }
    },
    upgrade(json, fromVersion) {
      if (fromVersion > version) {
        throw new ShardError(
          'schema/future-version',
          `"${name}" data is version ${fromVersion}, newer than this build's version ${version}`,
        )
      }
      let current = json
      for (let v = fromVersion; v < version; v++) current = options.migrate!(v, current)
      return current
    },
  }
}

/** A component with no fields. Takes part in queries; stores nothing. */
export function defineTag(
  name: string,
  options: Omit<ComponentOptions, 'version' | 'migrate'> = {},
): TagDef {
  return defineComponent(name, {}, options)
}
