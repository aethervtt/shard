import {
  type ComponentDef,
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
} from '@aethervtt/shard-core'
import { AppControl, AppControlResource } from './control'
import { FrameDemand, FrameDemandState } from './demand'
import { Log, LogResource } from './log'
import type { Plugin } from './plugin'
import type { Runner } from './runners'
import { OnEnter, OnExit, type StateDef } from './state'
import { DisplayRate, FixedTime, type FixedTimeData, GlobalRng, Time, type TimeData } from './time'

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

/**
 * A protocol method a plugin contributes (`physics.raycast`). The protocol server serves every
 * app method next to its built-in ones, so packages expose themselves without the protocol
 * importing them.
 */
export interface AppMethod {
  /** `<area>.<verb>`, e.g. `physics.raycast`. */
  name: string
  description: string
  /** Parameter schema (`defineSchema`); the protocol validates params against it. */
  params: ComponentDef
  handler(ctx: { app: App; world: World }, params: Record<string, unknown>): unknown
}

/**
 * Code the app runs happens inside its scopes: plugin builds and ready hooks, frames, pumps, and
 * disposal. The render plugin uses one to count GPU objects against the app (0052).
 */
export interface AppScope {
  enter(): void
  exit(): void
}

/** What a loop runner gives the app while it drives it (0052). */
export interface FrameDriver {
  /** Schedules a frame if none is coming (on-demand); a no-op for runners that run every frame. */
  requestFrame(): void
  /** Stops the loop for good. */
  stop(): void
}

/** Order the built-in schedules run in, for `describe()`. */
const FRAME_SCHEDULES = [Startup, First, PreUpdate, FixedUpdate, Update, PostUpdate, Last]

/** Floating-point slack when comparing accumulated time against the fixed step. */
const EPSILON = 1e-9

const TimePlugin: Plugin = {
  name: 'core/time',
  build(app) {
    app.insertResource(Time, { delta: 0, elapsed: 0, frame: 0 })
    app.insertResource(FixedTime, { step: 1 / app.fixedHz, elapsed: 0, alpha: 0, steps: 0 })
    app.insertResource(DisplayRate, { hz: 60, periodMs: 1000 / 60, source: 'assumed' })
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
  /** Plugins in the order they were built; disposal runs it backwards. */
  private readonly built: Plugin[] = []
  private readonly scopes: AppScope[] = []
  private driver: FrameDriver | undefined
  private disposing: Promise<void> | undefined
  private readonly schedules = new Map<ScheduleLabel, Schedule>()
  private readonly systemNames = new Set<string>()
  private readonly states: StateDriver[] = []
  private readonly profiler = new Profiler()
  private runner: Runner | undefined
  private initialized = false
  private startupDone = false
  private accumulator = 0
  private readonly frameListeners = new Set<(frame: number) => void>()
  private readonly appMethods = new Map<string, AppMethod>()
  /** The plugin whose `build` is running, so registrations can be attributed to it. */
  private building: string | undefined
  private readonly owned = new Map<
    string,
    {
      systems: { schedule: ScheduleLabel; name: string }[]
      sets: { schedule: ScheduleLabel; config: SystemSetConfig }[]
    }
  >()

  constructor(options: AppOptions = {}) {
    this.fixedHz = options.fixedHz ?? 60
    this.maxFixedSteps = options.maxFixedSteps ?? 5
    this.now = options.now ?? (() => performance.now())
    this.world.insertResource(ProfilerResource, this.profiler)
    this.world.insertResource(GlobalRng, new Rng(options.seed ?? 0))
    const log = new Log()
    log.now = () => this.world.tryResource(Time)?.elapsed ?? 0
    this.world.insertResource(LogResource, log)
    const control = new AppControl()
    control.onRequest = () => this.driver?.requestFrame()
    this.world.insertResource(AppControlResource, control)
    this.world.insertResource(FrameDemand, new FrameDemandState(this.now))
    this.addPlugin(TimePlugin)
  }

  // --- building --------------------------------------------------------------

  /** Adds plugins. They build in dependency order during `init()`. */
  addPlugin(...plugins: Plugin[]): this {
    this.assertLive()
    for (const plugin of plugins) {
      if (this.plugins.has(plugin.name)) {
        throw new ShardError('app/duplicate-plugin', `Plugin "${plugin.name}" was added twice`)
      }
      this.plugins.set(plugin.name, plugin)
      this.pending.push(plugin)
    }
    return this
  }

  /** Adds protocol methods (see `AppMethod`). A second method with a taken name throws. */
  addMethod(...methods: AppMethod[]): this {
    this.assertLive()
    for (const method of methods) {
      if (this.appMethods.has(method.name)) {
        throw new ShardError('app/duplicate-method', `Method "${method.name}" was added twice`)
      }
      this.appMethods.set(method.name, method)
    }
    return this
  }

  /** Methods plugins added, in the order they were added. */
  get methods(): readonly AppMethod[] {
    return [...this.appMethods.values()]
  }

  addSystems(schedule: ScheduleLabel, ...systems: SystemInput[]): this {
    this.assertLive()
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
      this.ownedBy()?.systems.push({ schedule, name })
    }
    return this
  }

  configureSets(schedule: ScheduleLabel, ...sets: SystemSetConfig[]): this {
    this.assertLive()
    const target = this.schedule(schedule)
    for (const set of sets) {
      target.configureSet(set)
      this.ownedBy()?.sets.push({ schedule, config: set })
    }
    return this
  }

  private ownedBy() {
    if (this.building === undefined) return undefined
    let owned = this.owned.get(this.building)
    if (!owned) {
      owned = { systems: [], sets: [] }
      this.owned.set(this.building, owned)
    }
    return owned
  }

  /** A registered system's run function, by name (hot reload compares them). */
  systemRun(name: string): ((...args: never[]) => unknown) | undefined {
    for (const schedule of this.schedules.values()) {
      for (const config of schedule.ordered()) {
        if (config.system.name === name) return config.system.run as (...args: never[]) => unknown
      }
    }
    return undefined
  }

  /** Names of the systems a plugin registered. */
  systemsOf(plugin: string): string[] {
    return this.owned.get(plugin)?.systems.map((s) => s.name) ?? []
  }

  /**
   * Removes a plugin from a running app: every system and set config it registered, and the plugin
   * itself. Resources and entities stay. For hot reload; returns the removed system names.
   */
  unloadPlugin(name: string): string[] {
    this.assertLive()
    const owned = this.owned.get(name)
    const plugin = this.plugins.get(name)
    const at = plugin ? this.built.indexOf(plugin) : -1
    if (at !== -1) this.built.splice(at, 1)
    this.plugins.delete(name)
    this.owned.delete(name)
    if (!owned) return []
    const bySchedule = new Map<
      ScheduleLabel,
      { systems: Set<string>; sets: Set<SystemSetConfig> }
    >()
    const entry = (label: ScheduleLabel) => {
      let e = bySchedule.get(label)
      if (!e) {
        e = { systems: new Set(), sets: new Set() }
        bySchedule.set(label, e)
      }
      return e
    }
    for (const s of owned.systems) entry(s.schedule).systems.add(s.name)
    for (const s of owned.sets) entry(s.schedule).sets.add(s.config)
    for (const [label, e] of bySchedule) this.schedules.get(label)?.remove(e.systems, e.sets)
    for (const s of owned.systems) this.systemNames.delete(s.name)
    return owned.systems.map((s) => s.name)
  }

  /**
   * Builds a plugin into an app that's already running (hot reload). Its systems set up on their
   * first run. Startup systems it adds don't run: startup already happened.
   */
  async loadPlugin(plugin: Plugin): Promise<void> {
    this.assertLive()
    if (this.plugins.has(plugin.name)) {
      throw new ShardError('app/duplicate-plugin', `Plugin "${plugin.name}" is already loaded`, {
        hint: 'Unload it first (unloadPlugin).',
      })
    }
    this.plugins.set(plugin.name, plugin)
    this.buildPlugin(plugin)
    await this.readyPlugin(plugin)
  }

  insertResource<T>(def: ResourceDef<T>, value: T): this {
    this.assertLive()
    this.world.insertResource(def, value)
    return this
  }

  /** Registers a state machine. `OnEnter(initial)` runs at the start of the first frame. */
  initState<T extends string>(state: StateDef<T>, initial: NoInfer<T> = state.values[0]!): this {
    this.assertLive()
    this.world.insertResource(state.resource, { current: initial, next: undefined })
    this.states.push({ state: state as StateDef<string>, entered: false })
    return this
  }

  setRunner(runner: Runner): this {
    this.assertLive()
    this.runner = runner
    return this
  }

  /** Builds plugins in dependency order, then awaits their `ready` hooks. */
  async init(): Promise<void> {
    this.assertLive()
    if (this.initialized) return
    const built: Plugin[] = []
    const builtNames = new Set<string>()
    while (this.pending.length > 0) {
      const index = this.pending.findIndex((p) =>
        (p.dependencies ?? []).every((d) => builtNames.has(d)),
      )
      if (index === -1) throw this.dependencyError(builtNames)
      const [plugin] = this.pending.splice(index, 1)
      this.buildPlugin(plugin!) // may add more plugins
      built.push(plugin!)
      builtNames.add(plugin!.name)
    }
    for (const plugin of built) await this.readyPlugin(plugin)
    this.initialized = true
  }

  /** Initializes, then hands control to the runner (manual if none was set). */
  async run(): Promise<void> {
    await this.init()
    await this.runner?.(this)
  }

  /**
   * Stops the runner, then disposes plugins in reverse build order, so each releases what it
   * created: GPU objects, surfaces, listeners, workers (0052). Idempotent; afterwards any other
   * call throws `runtime/disposed`. A plugin whose dispose throws is logged and the rest still run.
   */
  dispose(): Promise<void> {
    this.disposing ??= this.disposeAll()
    return this.disposing
  }

  /** True once `dispose()` was called. */
  get disposed(): boolean {
    return this.disposing !== undefined
  }

  /**
   * Adds a scope around everything the app runs (see `AppScope`). Returns a function that removes
   * it; don't call that from inside the app's own code (a frame, a plugin's dispose): disposal
   * drops every scope once plugins are done. Scopes enter in the order added and exit in reverse.
   */
  addScope(scope: AppScope): () => void {
    this.assertLive()
    this.scopes.push(scope)
    return () => {
      const i = this.scopes.indexOf(scope)
      if (i !== -1) this.scopes.splice(i, 1)
    }
  }

  /**
   * Called by a loop runner as it starts. `requestFrame` and `dispose` reach the loop through it.
   */
  attachDriver(driver: FrameDriver): void {
    this.assertLive()
    this.driver = driver
  }

  /**
   * Asks for a frame: an on-demand runner schedules one if none is coming (0052). Host code that
   * changes what's on screen without writing the world (a canvas style, a DOM overlay) calls it.
   */
  requestFrame(): void {
    this.assertLive()
    this.driver?.requestFrame()
  }

  /**
   * Drops accumulated fixed-step time, so the next frame runs FixedUpdate for its own delta only.
   * On-demand runners call it on waking, so a scene idle for a minute doesn't simulate the minute.
   */
  resetFixedTime(): void {
    this.accumulator = 0
  }

  // --- running ---------------------------------------------------------------

  /** Runs one frame. `delta` is in seconds. */
  update(delta: number): void {
    this.assertLive()
    if (!this.initialized) {
      throw new ShardError('app/not-initialized', 'App.update() was called before init()', {
        hint: 'Await app.init() (or app.run()) first.',
      })
    }
    const scoped = this.enter()
    try {
      this.frame(delta)
    } finally {
      this.exit(scoped)
    }
  }

  private frame(delta: number): void {
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
    for (const listener of this.frameListeners) listener(time.frame)
  }

  /** Called after every frame with the number of frames completed. Returns an unsubscribe function. */
  onFrame(listener: (frame: number) => void): () => void {
    this.assertLive()
    this.frameListeners.add(listener)
    return () => this.frameListeners.delete(listener)
  }

  /**
   * Runs any stepped frames requested through `AppControl` right now, at the fixed delta. For hosts
   * without a frame loop (headless servers); loop-driven runners step one frame per tick instead.
   */
  pump(): void {
    this.assertLive()
    const control = this.world.resource(AppControlResource)
    while (control.pendingSteps > 0) {
      try {
        this.update(1 / this.fixedHz)
      } catch (err) {
        // Log it where tools look, stop stepping, and let the caller see the failure.
        this.world.resource(LogResource).error(err)
        control.paused = true
        control.pausedByError = true
        control.abort(err)
        throw err
      }
      control.stepped()
    }
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

  private assertLive(): void {
    if (this.disposing === undefined) return
    throw new ShardError('runtime/disposed', 'This app was disposed', {
      hint: 'Create a new App; a disposed one has released its GPU objects and listeners.',
    })
  }

  /** Enters every scope; returns how many, for the matching `exit`. */
  private enter(): number {
    const n = this.scopes.length
    for (let i = 0; i < n; i++) this.scopes[i]!.enter()
    return n
  }

  /** Exits the first `n` scopes, so one added inside the section never sees an unmatched exit. */
  private exit(n: number): void {
    for (let i = Math.min(n, this.scopes.length) - 1; i >= 0; i--) this.scopes[i]!.exit()
  }

  private buildPlugin(plugin: Plugin): void {
    this.building = plugin.name
    const scoped = this.enter()
    try {
      plugin.build(this)
    } finally {
      this.exit(scoped)
      this.building = undefined
    }
    this.built.push(plugin)
  }

  /** Awaits a ready hook; the part that runs before its first await is inside the app's scopes. */
  private async readyPlugin(plugin: Plugin): Promise<void> {
    if (!plugin.ready) return
    const scoped = this.enter()
    let result: Promise<void> | void
    try {
      result = plugin.ready(this)
    } finally {
      this.exit(scoped)
    }
    await result
  }

  private async disposeAll(): Promise<void> {
    const driver = this.driver
    this.driver = undefined
    driver?.stop()
    this.frameListeners.clear()
    this.world.onWake = undefined
    this.world.asleep = false
    const log = this.world.tryResource(LogResource)
    let first: unknown
    for (let i = this.built.length - 1; i >= 0; i--) {
      const plugin = this.built[i]!
      if (!plugin.dispose) continue
      const scoped = this.enter()
      let result: Promise<void> | void
      try {
        result = plugin.dispose(this)
      } catch (err) {
        first ??= err
        log?.error(err)
        continue
      } finally {
        this.exit(scoped)
      }
      try {
        await result
      } catch (err) {
        first ??= err
        log?.error(err)
      }
    }
    this.built.length = 0
    this.scopes.length = 0
    if (first !== undefined) throw first
  }

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
