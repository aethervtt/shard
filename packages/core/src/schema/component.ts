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
import { allocateId, assertName, isRedefinable, recordRedefinition } from './names'

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
  /** False for derived components (computed each frame), which scene files never contain. */
  serialize?: boolean
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
  /** Whether scene files and the protocol write this component. */
  readonly serializable: boolean
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

/** Every component defined in this process, by name, so files can refer to types by name. */
const definitions = new Map<string, ComponentDef[]>()

/**
 * The component defined under `name`, or undefined. Throws `schema/ambiguous-name` if two different
 * definitions share the name (a world's registry would reject that too).
 */
export function findComponent(name: string): ComponentDef | undefined {
  const defs = definitions.get(name)
  if (!defs || defs.length === 0) return undefined
  if (defs.length > 1) {
    throw new ShardError('schema/ambiguous-name', `Several components are defined as "${name}"`, {
      hint: 'Two modules define the same name. Rename one, or import the shared definition.',
    })
  }
  return defs[0]
}

/** All component definitions, sorted by name. */
export function allComponents(): ComponentDef[] {
  return [...definitions.values()].flat().sort((a, b) => a.name.localeCompare(b.name))
}
export type Infer<C> = C extends ComponentDef<infer F> ? InferFields<F> : never

export function defineComponent<const F extends Fields>(
  name: string,
  fields: F,
  options: ComponentOptions = {},
): ComponentDef<F> {
  const existing = definitions.get(name)
  const previous = existing && isRedefinable(name) ? existing.at(-1) : undefined
  const def = buildSchema(name, fields, options, previous?.id)
  if (previous) {
    definitions.set(name, [def as ComponentDef])
    recordRedefinition({
      kind: 'component',
      name,
      previous,
      next: def,
      undo: () => definitions.set(name, [previous]),
    })
  } else if (existing) existing.push(def as ComponentDef)
  else definitions.set(name, [def as ComponentDef])
  return def
}

/**
 * A schema for data that isn't an entity component (file formats, protocol parameters, settings):
 * validation, defaults, (de)serialization, and JSON Schema, without joining the component catalog.
 */
export function defineSchema<const F extends Fields>(
  name: string,
  fields: F,
  options: Pick<ComponentOptions, 'description' | 'version' | 'migrate'> = {},
): ComponentDef<F> {
  return buildSchema(name, fields, { ...options, serialize: false })
}

function buildSchema<const F extends Fields>(
  name: string,
  fields: F,
  options: ComponentOptions,
  reuseId?: number,
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

  const def: ComponentDef<F> = {
    kind: 'component',
    id: reuseId ?? allocateId(),
    name,
    fields,
    isTag: layout.length === 0,
    description: options.description,
    version,
    layout,
    requires: options.requires ?? [],
    serializable: options.serialize ?? true,
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
  return def
}

/** A component with no fields. Takes part in queries; stores nothing. */
export function defineTag(
  name: string,
  options: Omit<ComponentOptions, 'version' | 'migrate'> = {},
): TagDef {
  return defineComponent(name, {}, options)
}
