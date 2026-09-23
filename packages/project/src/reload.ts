import {
  allComponents,
  beginRedefinition,
  type ComponentDef,
  defineEvent,
  type Entity,
  type EventDef,
  endRedefinition,
  findResource,
  type Redefinition,
  type ResourceDef,
  ShardError,
  type World,
} from '@shard/core'
import type { App, Plugin } from '@shard/runtime'
import { pathOfEntity } from '@shard/scene'

export interface ReloadReport {
  ok: boolean
  ms: number
  /** Components whose layout changed and whose data was migrated. */
  migrated: string[]
  /** Components the new code no longer defines; kept in the world with their old definition. */
  orphaned: string[]
  systems: { added: string[]; removed: string[]; changed: string[] }
  error?: { code: string; message: string; path?: string; hint?: string; source?: string }
}

/** Sent after every successful project reload, with its report. */
export const ProjectReloaded = defineEvent<ReloadReport>('project/ProjectReloaded', {
  description: 'The project code was hot reloaded.',
})

type ModuleLoader = () => Promise<{ default?: unknown }>

interface Plan {
  def: ComponentDef
  previous: ComponentDef
  /** Old and new values by entity, for a changed layout (undefined when the layout matches). */
  values?: {
    before: Map<Entity, Record<string, unknown>>
    after: Map<Entity, Record<string, unknown>>
  }
}

/** Two definitions store data the same way: same fields, kinds, strides, storage, and version. */
function sameLayout(a: ComponentDef, b: ComponentDef): boolean {
  if (a.version !== b.version || a.layout.length !== b.layout.length) return false
  for (let i = 0; i < a.layout.length; i++) {
    const x = a.layout[i]!
    const y = b.layout[i]!
    if (
      x.name !== y.name ||
      x.storage !== y.storage ||
      x.stride !== y.stride ||
      x.field.kind !== y.field.kind
    )
      return false
  }
  return true
}

function asPlugin(mod: { default?: unknown }): Plugin {
  const plugin = mod.default as Plugin | undefined
  if (!plugin || typeof plugin.build !== 'function' || typeof plugin.name !== 'string') {
    throw new ShardError(
      'project/entry-invalid',
      'The project bundle has no plugin as its default export',
      {
        hint: 'End the entry file with `export default project`, where project = defineProject({...}).',
      },
    )
  }
  return plugin
}

/**
 * Hot reload for a project's code. `reload` evaluates the new bundle inside a redefinition scope,
 * migrates component data whose layout changed, swaps the project's systems and observers, and
 * keeps entities and resources. Any failure rolls everything back and the old code keeps running.
 */
export function createProjectReloader(app: App, options: { namespace: string; current: Plugin }) {
  let current = options.current
  const world = app.world
  const observerStops = new Map<string, (() => void)[]>()

  /** Runs a plugin's build, capturing observers it registers and keeping existing resources. */
  const build = async (plugin: Plugin): Promise<void> => {
    const saved = new Map<number, [ResourceDef<unknown>, unknown]>()
    for (const name of namespaceResources()) {
      const def = findResource(name)!
      if (world.hasResource(def)) saved.set(def.id, [def, world.resource(def)])
    }
    const stops: (() => void)[] = []
    const observe = world.observe.bind(world)
    ;(world as { observe: unknown }).observe = (...args: Parameters<World['observe']>) => {
      const stop = (observe as (...a: unknown[]) => () => void)(...args)
      stops.push(stop)
      return stop
    }
    try {
      await app.loadPlugin(plugin)
    } finally {
      ;(world as { observe: unknown }).observe = observe
      observerStops.set(plugin.name, stops)
      for (const [id, [oldDef, value]] of saved) {
        const def = (findResource(oldDef.name) ?? oldDef) as ResourceDef<unknown>
        if (def.id === id && def.reload !== 'replace') world.insertResource(def, value)
      }
    }
  }

  const unload = (plugin: Plugin): string[] => {
    for (const stop of observerStops.get(plugin.name) ?? []) stop()
    observerStops.delete(plugin.name)
    return app.unloadPlugin(plugin.name)
  }

  const namespaceResources = (): string[] => {
    const out: string[] = []
    for (const def of world.registry.describe().resources) {
      if (def.name.startsWith(`${options.namespace}/`)) out.push(def.name)
    }
    return out
  }

  /** Builds the migration plan without touching the world; throws on data that won't fit. */
  const plan = (changes: readonly Redefinition[]): Plan[] => {
    const plans: Plan[] = []
    for (const change of changes) {
      if (change.kind !== 'component') continue
      const previous = change.previous as ComponentDef
      const def = change.next as ComponentDef
      if (sameLayout(previous, def)) {
        plans.push({ def, previous })
        continue
      }
      const before = new Map<Entity, Record<string, unknown>>()
      const after = new Map<Entity, Record<string, unknown>>()
      const fields = new Set(def.layout.map((c) => c.name))
      for (const table of world.allTables()) {
        if (!table.hasId(def.id)) continue
        for (let row = 0; row < table.count; row++) {
          const entity = table.entities[row]! as Entity
          const value = table.readComponent(previous, row) as Record<string, unknown>
          let json: unknown = previous.serialize(value as never)
          if (def.version > previous.version) json = def.upgrade(json, previous.version)
          if (json && typeof json === 'object' && !Array.isArray(json)) {
            json = Object.fromEntries(Object.entries(json).filter(([k]) => fields.has(k)))
          }
          const errors = def.validate(json)
          if (errors.length > 0) {
            const where = pathOfEntity(world, entity) ?? `entity ${entity}`
            throw new ShardError(
              'project/migration-failed',
              `Can't migrate ${def.name} on ${where}: ${errors[0]!.message}`,
              {
                path: errors[0]!.path,
                hint: 'Bump the component version and convert the old value in `migrate`, or change the field back.',
                details: errors,
              },
            )
          }
          before.set(entity, value)
          after.set(entity, def.deserialize(json) as Record<string, unknown>)
        }
      }
      plans.push({ def, previous, values: { before, after } })
    }
    return plans
  }

  const apply = (plans: readonly Plan[], direction: 'forward' | 'back') => {
    for (const p of plans) {
      const def = direction === 'forward' ? p.def : p.previous
      const values = p.values && (direction === 'forward' ? p.values.after : p.values.before)
      world.redefine(def, values && ((_, entity) => values.get(entity)!))
    }
  }

  const redefineOthers = (changes: readonly Redefinition[], direction: 'forward' | 'back') => {
    for (const c of changes) {
      if (c.kind === 'component') continue
      world.redefine((direction === 'forward' ? c.next : c.previous) as EventDef<unknown>)
    }
  }

  const systemSources = (plugin: Plugin): Map<string, string> => {
    const out = new Map<string, string>()
    for (const name of app.systemsOf(plugin.name)) {
      const run = app.systemRun(name)
      out.set(name, run ? run.toString() : '')
    }
    return out
  }

  return {
    get current(): Plugin {
      return current
    },

    async reload(load: ModuleLoader): Promise<ReloadReport> {
      const start = performance.now()
      const report: ReloadReport = {
        ok: false,
        ms: 0,
        migrated: [],
        orphaned: [],
        systems: { added: [], removed: [], changed: [] },
      }
      const finish = (error?: unknown): ReloadReport => {
        report.ms = performance.now() - start
        if (error !== undefined) {
          const e =
            error instanceof ShardError
              ? error
              : new ShardError(
                  'project/reload-failed',
                  String((error as Error)?.message ?? error),
                  {
                    cause: error,
                  },
                )
          report.error = {
            code: e.code,
            message: e.message,
            ...(e.path ? { path: e.path } : {}),
            ...(e.hint ? { hint: e.hint } : {}),
            ...(sourceOf(error) ? { source: sourceOf(error) } : {}),
          }
          return report
        }
        report.ok = true
        world.send(ProjectReloaded, report)
        return report
      }

      const before = new Set(
        allComponents()
          .filter((d) => d.name.startsWith(`${options.namespace}/`))
          .map((d) => d.name),
      )
      // 1. Evaluate the new code; redefinitions keep their ids.
      let changes: Redefinition[]
      let next: Plugin
      beginRedefinition(options.namespace)
      try {
        next = asPlugin(await load())
      } catch (err) {
        for (const c of endRedefinition()) c.undo()
        return finish(err)
      }
      changes = endRedefinition()
      const redefined = new Set(changes.map((c) => c.name))
      report.orphaned = [...before].filter((n) => !redefined.has(n)).sort()

      // 2. Plan migrations (reads only).
      let plans: Plan[]
      try {
        plans = plan(changes)
      } catch (err) {
        for (const c of changes) c.undo()
        return finish(err)
      }

      // 3. Swap: migrate data, replace the plugin. Roll back on any throw.
      const oldSources = systemSources(current)
      apply(plans, 'forward')
      redefineOthers(changes, 'forward')
      unload(current)
      try {
        await build(next)
      } catch (err) {
        unload(next)
        apply(plans, 'back')
        redefineOthers(changes, 'back')
        for (const c of changes) c.undo()
        await build(current)
        return finish(err)
      }
      const newSources = systemSources(next)
      current = next
      report.migrated = plans.filter((p) => p.values).map((p) => p.def.name)
      for (const [name, src] of newSources) {
        if (!oldSources.has(name)) report.systems.added.push(name)
        else if (oldSources.get(name) !== src) report.systems.changed.push(name)
      }
      for (const name of oldSources.keys())
        if (!newSources.has(name)) report.systems.removed.push(name)
      return finish()
    },
  }
}

export type ProjectReloader = ReturnType<typeof createProjectReloader>

/** The source location a bundle error carries (`file:line:col`), if any. */
function sourceOf(err: unknown): string | undefined {
  const source = (err as { source?: unknown })?.source
  return typeof source === 'string' ? source : undefined
}
