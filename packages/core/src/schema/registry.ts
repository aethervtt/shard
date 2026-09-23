import { ShardError } from '../error'
import type { JsonSchema } from '../json'
import type { ComponentDef } from './component'
import type { EventDef, ResourceDef } from './resource'

type Def = ComponentDef | ResourceDef<unknown> | EventDef<unknown>

export interface RegistryDescription {
  components: {
    name: string
    description?: string
    version: number
    tag: boolean
    requires: string[]
    schema: JsonSchema
  }[]
  resources: { name: string; description?: string }[]
  events: { name: string; description?: string }[]
}

/**
 * Names in use by one world. Registering the same definition twice is fine; registering a
 * different definition under a taken name is an error.
 */
export class Registry {
  private readonly byName = new Map<string, Def>()
  private readonly byId: (Def | undefined)[] = []

  register(def: Def): void {
    if (this.byId[def.id] === def) return
    const existing = this.byName.get(def.name)
    if (existing && existing !== def) {
      throw new ShardError('schema/duplicate-name', `"${def.name}" is already registered`, {
        hint: 'Two definitions share a name. Rename one, or import the existing definition.',
      })
    }
    this.byName.set(def.name, def)
    this.byId[def.id] = def
  }

  /** Swaps in a definition that reuses an existing one's id (hot reload). */
  replace(def: Def): void {
    const old = this.byId[def.id]
    if (old && this.byName.get(old.name) === old) this.byName.delete(old.name)
    this.byName.set(def.name, def)
    this.byId[def.id] = def
  }

  isRegistered(def: Def): boolean {
    return this.byId[def.id] === def
  }

  get(name: string): Def | undefined {
    return this.byName.get(name)
  }

  component(name: string): ComponentDef | undefined {
    const def = this.byName.get(name)
    return def?.kind === 'component' ? def : undefined
  }

  describe(): RegistryDescription {
    const out: RegistryDescription = { components: [], resources: [], events: [] }
    const sorted = [...this.byName.values()].sort((a, b) => a.name.localeCompare(b.name))
    for (const def of sorted) {
      const description = def.description ? { description: def.description } : {}
      if (def.kind === 'component') {
        out.components.push({
          name: def.name,
          ...description,
          version: def.version,
          tag: def.isTag,
          requires: def.requires.map((r) => r.name),
          schema: def.jsonSchema(),
        })
      } else if (def.kind === 'resource') {
        out.resources.push({ name: def.name, ...description })
      } else {
        out.events.push({ name: def.name, ...description })
      }
    }
    return out
  }
}
