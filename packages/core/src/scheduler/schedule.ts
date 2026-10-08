import { Commands } from '../ecs/commands'
import type { EventReader } from '../ecs/events'
import type { World } from '../ecs/world'
import { ShardError } from '../error'
import type { EventDef } from '../schema/resource'
import { defineSpan, type Profiler, type SpanDef, TRACK } from './profiler'
import {
  type Condition,
  conditionLabel,
  type Label,
  SystemConfig,
  type SystemContext,
  type SystemDef,
  type SystemSetConfig,
} from './system'

export interface ScheduleLabel {
  readonly kind: 'schedule'
  readonly name: string
}

export function defineSchedule(name: string): ScheduleLabel {
  return { kind: 'schedule', name }
}

/** Runs once, before the first frame. */
export const Startup = defineSchedule('Startup')
export const First = defineSchedule('First')
export const PreUpdate = defineSchedule('PreUpdate')
/** Runs 0..N times per frame at a fixed rate. */
export const FixedUpdate = defineSchedule('FixedUpdate')
export const Update = defineSchedule('Update')
export const PostUpdate = defineSchedule('PostUpdate')
export const Last = defineSchedule('Last')

export interface ScheduleRunOptions {
  now: () => number
  profiler?: Profiler | undefined
}

export interface SystemDescription {
  name: string
  description?: string
  after: string[]
  before: string[]
  sets: string[]
  conditions: string[]
}

class Context implements SystemContext {
  lastRunTick = 0
  thisRunTick = 0
  readonly commands: Commands
  private readonly world: World
  private readonly readers = new Map<number, EventReader<unknown>>()

  constructor(world: World) {
    this.world = world
    this.commands = new Commands(world)
  }

  reader<T>(event: EventDef<T>): EventReader<T> {
    let reader = this.readers.get(event.id)
    if (!reader) {
      reader = this.world.reader(event as EventDef<unknown>)
      this.readers.set(event.id, reader)
    }
    return reader as EventReader<T>
  }
}

interface Entry {
  readonly config: SystemConfig
  /** The system's span: its name. */
  readonly span: SpanDef
  readonly index: number
  state: unknown
  ctx: Context | undefined
  conditions: readonly Condition[]
}

/**
 * An ordered set of systems. Order comes from `after`/`before` constraints (on systems and
 * sets); systems with no relation keep registration order, so runs are deterministic.
 */
export class Schedule {
  readonly label: ScheduleLabel
  /** `schedule/<Label>`: one run of the schedule (0074). */
  private readonly span: SpanDef
  /** `commands/<Label>`: command application over one run. */
  private readonly commandsSpan: SpanDef
  private readonly entries: Entry[] = []
  private readonly setConfigs: SystemSetConfig[] = []
  private order: Entry[] | undefined

  constructor(label: ScheduleLabel) {
    this.label = label
    this.span = defineSpan(`schedule/${label.name}`)
    this.commandsSpan = defineSpan(`commands/${label.name}`)
  }

  add(system: SystemDef<unknown> | SystemConfig): void {
    const config = system instanceof SystemConfig ? system : new SystemConfig(system)
    this.entries.push({
      config,
      span: defineSpan(config.system.name),
      index: this.entries.length,
      state: undefined,
      ctx: undefined,
      conditions: [],
    })
    this.order = undefined
  }

  /** Removes systems by name and set configs by identity (hot reload). Returns how many systems went. */
  remove(systems: ReadonlySet<string>, sets: ReadonlySet<SystemSetConfig> = new Set()): number {
    const before = this.entries.length
    const kept = this.entries.filter((e) => !systems.has(e.config.system.name))
    this.entries.length = 0
    for (let index = 0; index < kept.length; index++) this.entries.push({ ...kept[index]!, index })
    const keptSets = this.setConfigs.filter((c) => !sets.has(c))
    this.setConfigs.length = 0
    this.setConfigs.push(...keptSets)
    this.order = undefined
    return before - this.entries.length
  }

  configureSet(config: SystemSetConfig): void {
    this.setConfigs.push(config)
    this.order = undefined
  }

  get size(): number {
    return this.entries.length
  }

  /** Systems in the order they run. Throws `app/system-cycle` if constraints form a cycle. */
  ordered(): readonly SystemConfig[] {
    return this.resolve().map((e) => e.config)
  }

  run(world: World, options: ScheduleRunOptions): void {
    const order = this.resolve()
    const profiler = options.profiler
    const scheduleToken = profiler !== undefined ? profiler.begin(this.span) : -1
    let commandsMs = 0
    for (let i = 0; i < order.length; i++) {
      const entry = order[i]!
      const conditions = entry.conditions
      let skip = false
      for (let c = 0; c < conditions.length; c++) {
        if (!conditions[c]!(world)) {
          skip = true
          break
        }
      }
      if (skip) continue

      const system = entry.config.system
      if (!entry.ctx) {
        entry.ctx = new Context(world)
        entry.state = system.setup ? system.setup(world) : undefined
      }
      const ctx = entry.ctx
      ctx.thisRunTick = world.incrementTick()
      const token = profiler !== undefined ? profiler.begin(entry.span) : -1
      try {
        system.run(entry.state, world, ctx)
      } catch (err) {
        profiler?.cancel(scheduleToken)
        const message = err instanceof Error ? err.message : String(err)
        const code = err instanceof ShardError ? ` [${err.code}]` : ''
        throw new ShardError(
          'app/system-failed',
          `System "${system.name}" failed${code}: ${message}`,
          {
            cause: err,
            hint: err instanceof ShardError ? err.hint : undefined,
          },
        )
      }
      if (profiler !== undefined) profiler.end(token)
      ctx.lastRunTick = ctx.thisRunTick
      // Anything written from here on (commands, later systems, code outside systems between
      // frames) gets a newer tick than this run, so this system sees it as changed next time.
      world.incrementTick()
      if (ctx.commands.length > 0) {
        if (profiler === undefined) ctx.commands.apply()
        else {
          const start = profiler.now()
          try {
            ctx.commands.apply()
          } catch (err) {
            profiler.cancel(scheduleToken)
            throw err
          }
          const ms = profiler.now() - start
          commandsMs += ms
          profiler.event(this.commandsSpan, TRACK.main, start, ms)
        }
      }
    }
    if (profiler !== undefined) {
      profiler.sample(this.commandsSpan, commandsMs)
      profiler.end(scheduleToken)
    }
  }

  describe(): SystemDescription[] {
    const setConditions = this.setConditionMap()
    return this.ordered().map((config) => {
      const out: SystemDescription = {
        name: config.system.name,
        after: config.afterLabels.map((l) => l.name),
        before: config.beforeLabels.map((l) => l.name),
        sets: config.sets.map((s) => s.name),
        conditions: [
          ...config.sets.flatMap((s) => setConditions.get(s.name) ?? []),
          ...config.conditions,
        ].map(conditionLabel),
      }
      if (config.system.description) out.description = config.system.description
      return out
    })
  }

  private setConditionMap(): Map<string, Condition[]> {
    const map = new Map<string, Condition[]>()
    for (const sc of this.setConfigs) {
      map.set(sc.set.name, [...(map.get(sc.set.name) ?? []), ...sc.conditions])
    }
    return map
  }

  private resolve(): Entry[] {
    if (this.order) return this.order
    const entries = this.entries
    const n = entries.length
    const edges = entries.map(() => new Set<number>())
    const indegree = new Array<number>(n).fill(0)
    const link = (from: number, to: number) => {
      if (from === to || edges[from]!.has(to)) return
      edges[from]!.add(to)
      indegree[to]!++
    }
    const targets = (label: Label): number[] =>
      entries
        .filter((e) =>
          label.kind === 'system' ? e.config.system === label : e.config.sets.includes(label),
        )
        .map((e) => e.index)

    for (const entry of entries) {
      for (const label of entry.config.afterLabels) {
        for (const t of targets(label)) link(t, entry.index)
      }
      for (const label of entry.config.beforeLabels) {
        for (const t of targets(label)) link(entry.index, t)
      }
    }
    for (const sc of this.setConfigs) {
      const members = targets(sc.set)
      for (const label of sc.afterLabels) {
        for (const t of targets(label)) for (const m of members) link(t, m)
      }
      for (const label of sc.beforeLabels) {
        for (const t of targets(label)) for (const m of members) link(m, t)
      }
    }

    // Kahn's algorithm, always taking the earliest-registered ready system.
    const order: Entry[] = []
    const done = new Array<boolean>(n).fill(false)
    for (let step = 0; step < n; step++) {
      let next = -1
      for (let i = 0; i < n; i++) {
        if (!done[i] && indegree[i] === 0) {
          next = i
          break
        }
      }
      if (next === -1) throw this.cycleError(edges, done)
      done[next] = true
      order.push(entries[next]!)
      for (const to of edges[next]!) indegree[to]!--
    }

    const setConditions = this.setConditionMap()
    for (const entry of entries) {
      entry.conditions = [
        ...entry.config.sets.flatMap((s) => setConditions.get(s.name) ?? []),
        ...entry.config.conditions,
      ]
    }
    this.order = order
    return order
  }

  private cycleError(edges: Set<number>[], done: boolean[]): ShardError {
    // Every unfinished system still has an unfinished predecessor, so walking backwards
    // through predecessors must eventually repeat a system. That loop is the cycle.
    const preds = edges.map(() => [] as number[])
    edges.forEach((targets, from) => {
      for (const to of targets) preds[to]!.push(from)
    })
    const start = done.indexOf(false)
    const path: number[] = [start]
    const seen = new Map<number, number>([[start, 0]])
    let current = start
    for (;;) {
      const prev = preds[current]!.find((p) => !done[p])!
      if (seen.has(prev)) {
        const cycle = path.slice(seen.get(prev)!).reverse()
        const names = [...cycle, cycle[0]!].map((i) => this.entries[i]!.config.system.name)
        return new ShardError(
          'app/system-cycle',
          `Systems in ${this.label.name} form an ordering cycle: ${names.join(' → ')}`,
          { hint: 'Remove one of the after/before constraints in this cycle.' },
        )
      }
      seen.set(prev, path.length)
      path.push(prev)
      current = prev
    }
  }
}
