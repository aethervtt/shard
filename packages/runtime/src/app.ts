import {
  First,
  FixedUpdate,
  Last,
  PostUpdate,
  PreUpdate,
  Profiler,
  ProfilerResource,
  type ResourceDef,
  Rng,
  Schedule,
  type ScheduleLabel,
  ShardError,
  Startup,
  type SystemConfig,
  type SystemDef,
  type SystemDescription,
  type SystemSetConfig,
  Update,
  World,
} from '@shard/core'
import type { Plugin } from './plugin'
import type { Runner } from './runners'
import { OnEnter, OnExit, type StateDef } from './state'
import { FixedTime, type FixedTimeData, GlobalRng, Time, type TimeData } from './time'

export interface AppOptions {
  /** FixedUpdate rate. Default 60. */
  fixedHz?: number
  /** Most FixedUpdate runs per frame; excess time is dropped. Default 5. */
  maxFixedSteps?: number
  /** Clock for profiling, in ms. Defaults to `performance.now`. */
  now?: () => number
  /** Seed for the `GlobalRng` resource. Default 0. */
  seed?: number
}

export interface AppDescription {
  plugins: { name: string; dependencies: string[] }[]
  schedules: { name: string; systems: SystemDescription[] }[]
}

type SystemInput = SystemDef<unknown> | SystemConfig

/** Order the built-in schedules run in, for `describe()`. */
const FRAME_SCHEDULES = [Startup, First, PreUpdate, FixedUpdate, Update, PostUpdate, Last]

/** Floating-point slack when comparing accumulated time against the fixed step. */
const EPSILON = 1e-9

const TimePlugin: Plugin = {
  name: 'core/time',
  build(app) {
    app.insertResource(Time, { delta: 0, elapsed: 0, frame: 0 })
    app.insertResource(FixedTime, { step: 1 / app.fixedHz, elapsed: 0, alpha: 0, steps: 0 })
  },
}

interface StateDriver {
  readonly state: StateDef<string>
  entered: boolean
}

/**
 * Owns the world, plugins, and schedules, and runs frames. Hosts drive it with a runner
 * (animation frame, headless, or manual `update` calls).
 */
export class App {
  readonly world = new World()
  readonly fixedHz: number
  private readonly maxFixedSteps: number
  private readonly now: () => number
  private readonly plugins = new Map<string, Plugin>()
  private readonly pending: Plugin[] = []
  private readonly schedules = new Map<ScheduleLabel, Schedule>()
  private readonly systemNames = new Set<string>()
  private readonly states: StateDriver[] = []
  private readonly profiler = new Profiler()
  private runner: Runner | undefined
  private initialized = false
  private startupDone = false
  private accumulator = 0

  constructor(options: AppOptions = {}) {
    this.fixedHz = options.fixedHz ?? 60
    this.maxFixedSteps = options.maxFixedSteps ?? 5
    this.now = options.now ?? (() => performance.now())
    this.world.insertResource(ProfilerResource, this.profiler)
    this.world.insertResource(GlobalRng, new Rng(options.seed ?? 0))
    this.addPlugin(TimePlugin)
  }

  // --- building --------------------------------------------------------------

  /** Adds plugins. They build in dependency order during `init()`. */
  addPlugin(...plugins: Plugin[]): this {
    for (const plugin of plugins) {
      if (this.plugins.has(plugin.name)) {
        throw new ShardError('app/duplicate-plugin', `Plugin "${plugin.name}" was added twice`)
      }
      this.plugins.set(plugin.name, plugin)
      this.pending.push(plugin)
    }
    return this
  }

  addSystems(schedule: ScheduleLabel, ...systems: SystemInput[]): this {
    const target = this.schedule(schedule)
    for (const system of systems) {
      const name = 'system' in system ? system.system.name : system.name
      if (this.systemNames.has(name)) {
        throw new ShardError('app/duplicate-system', `A system named "${name}" was already added`, {
          hint: 'System names must be unique across all schedules.',
        })
      }
      this.systemNames.add(name)
      target.add(system)
    }
    return this
  }

  configureSets(schedule: ScheduleLabel, ...sets: SystemSetConfig[]): this {
    const target = this.schedule(schedule)
    for (const set of sets) target.configureSet(set)
    return this
  }

  insertResource<T>(def: ResourceDef<T>, value: T): this {
    this.world.insertResource(def, value)
    return this
  }

  /** Registers a state machine. `OnEnter(initial)` runs at the start of the first frame. */
  initState<T extends string>(state: StateDef<T>, initial: NoInfer<T> = state.values[0]!): this {
    this.world.insertResource(state.resource, { current: initial, next: undefined })
    this.states.push({ state: state as StateDef<string>, entered: false })
    return this
  }

  setRunner(runner: Runner): this {
    this.runner = runner
    return this
  }

  /** Builds plugins in dependency order, then awaits their `ready` hooks. */
  async init(): Promise<void> {
    if (this.initialized) return
    const built: Plugin[] = []
    const builtNames = new Set<string>()
    while (this.pending.length > 0) {
      const index = this.pending.findIndex((p) =>
        (p.dependencies ?? []).every((d) => builtNames.has(d)),
      )
      if (index === -1) throw this.dependencyError(builtNames)
      const [plugin] = this.pending.splice(index, 1)
      plugin!.build(this) // may add more plugins
      built.push(plugin!)
      builtNames.add(plugin!.name)
    }
    for (const plugin of built) await plugin.ready?.(this)
    this.initialized = true
  }

  /** Initializes, then hands control to the runner (manual if none was set). */
  async run(): Promise<void> {
    await this.init()
    await this.runner?.(this)
  }

  // --- running ---------------------------------------------------------------

  /** Runs one frame. `delta` is in seconds. */
  update(delta: number): void {
    if (!this.initialized) {
      throw new ShardError('app/not-initialized', 'App.update() was called before init()', {
        hint: 'Await app.init() (or app.run()) first.',
      })
    }
    const world = this.world
    if (!this.startupDone) {
      this.runSchedule(Startup)
      this.startupDone = true
    }
    this.applyStateTransitions()
    world.updateEvents()

    const time = world.resource(Time) as TimeData
    time.delta = delta
    time.elapsed += delta

    this.runSchedule(First)
    this.runSchedule(PreUpdate)

    const fixed = world.resource(FixedTime) as FixedTimeData
    this.accumulator += delta
    let steps = 0
    while (this.accumulator + EPSILON >= fixed.step && steps < this.maxFixedSteps) {
      fixed.elapsed += fixed.step
      this.runSchedule(FixedUpdate)
      this.accumulator = Math.max(0, this.accumulator - fixed.step)
      steps++
    }
    // Clamped: drop whole steps we couldn't run so we don't spiral.
    if (this.accumulator + EPSILON >= fixed.step) this.accumulator %= fixed.step
    fixed.steps = steps
    fixed.alpha = Math.min(1, this.accumulator / fixed.step)

    this.runSchedule(Update)
    this.runSchedule(PostUpdate)
    this.runSchedule(Last)
    time.frame++
  }

  runSchedule(label: ScheduleLabel): void {
    const schedule = this.schedules.get(label)
    if (schedule && schedule.size > 0) {
      schedule.run(this.world, { now: this.now, profiler: this.profiler })
    }
  }

  // --- introspection ---------------------------------------------------------

  describe(): AppDescription {
    const order = [
      ...FRAME_SCHEDULES.filter((l) => this.schedules.has(l)),
      ...[...this.schedules.keys()].filter((l) => !FRAME_SCHEDULES.includes(l)),
    ]
    return {
      plugins: [...this.plugins.values()].map((p) => ({
        name: p.name,
        dependencies: [...(p.dependencies ?? [])],
      })),
      schedules: order.map((label) => ({
        name: label.name,
        systems: this.schedules.get(label)!.describe(),
      })),
    }
  }

  // --- internals -------------------------------------------------------------

  private schedule(label: ScheduleLabel): Schedule {
    let schedule = this.schedules.get(label)
    if (!schedule) {
      schedule = new Schedule(label)
      this.schedules.set(label, schedule)
    }
    return schedule
  }

  private applyStateTransitions(): void {
    for (const driver of this.states) {
      const value = this.world.resource(driver.state.resource)
      if (!driver.entered) {
        driver.entered = true
        this.runSchedule(OnEnter(driver.state, value.current))
      }
      const next = value.next
      value.next = undefined
      if (next === undefined || next === value.current) continue
      this.runSchedule(OnExit(driver.state, value.current))
      value.current = next
      this.runSchedule(OnEnter(driver.state, next))
    }
  }

  private dependencyError(built: Set<string>): ShardError {
    for (const plugin of this.pending) {
      for (const dep of plugin.dependencies ?? []) {
        if (!this.plugins.has(dep)) {
          return new ShardError(
            'app/missing-plugin',
            `Plugin "${plugin.name}" depends on "${dep}", which was never added`,
            { hint: `Add the "${dep}" plugin before calling init().` },
          )
        }
      }
    }
    const stuck = this.pending.map((p) => p.name).filter((n) => !built.has(n))
    return new ShardError(
      'app/plugin-cycle',
      `Plugins depend on each other in a cycle: ${stuck.join(', ')}`,
    )
  }
}
