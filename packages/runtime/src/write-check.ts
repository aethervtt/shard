import { allResources, isPlainObject, type ResourceDef, type World } from '@aethervtt/shard-core'
import type { Log } from './log'

/** How often the idle write check compares hostWritable resources, in ms. */
const CHECK_MS = 1000

/** A plain-object resource's contents, compared while idle. */
function hashOf(value: unknown): string | undefined {
  if (!isPlainObject(value)) return undefined
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}

/**
 * The on-demand runner's dev check (0052): while the app is idle, every second, compare the
 * plain-object resources marked `hostWritable` with their values when it went idle, and log
 * `runtime/unmarked-resource-write` for one that changed without waking the app. Loaded only when
 * `checkResourceWrites` is on, so production builds don't carry it.
 */
export class ResourceWriteCheck {
  private readonly snapshots = new Map<ResourceDef<unknown>, string>()
  private timer: ReturnType<typeof setInterval> | undefined
  private readonly world: World
  private readonly log: Log | undefined
  private readonly quiet: () => boolean

  /** `quiet`: still idle with no frame requested, so a change nobody announced is a bug. */
  constructor(world: World, log: Log | undefined, quiet: () => boolean) {
    this.world = world
    this.log = log
    this.quiet = quiet
  }

  /** The app went idle: remember what the resources hold, and check them every second. */
  start(): void {
    this.snapshots.clear()
    for (const def of allResources()) {
      if (!def.hostWritable) continue
      const hash = hashOf(this.world.tryResource(def))
      if (hash !== undefined) this.snapshots.set(def, hash)
    }
    this.timer ??= setInterval(() => this.verify(), CHECK_MS)
  }

  /** A frame is running (or the loop stopped): writes are fine again. */
  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  private verify(): void {
    if (!this.quiet()) return // a frame is coming; it snapshots again when it ends
    for (const [def, before] of this.snapshots) {
      const now = hashOf(this.world.tryResource(def)) ?? ''
      if (now === before) continue
      this.snapshots.set(def, now)
      this.log?.log('warn', `Resource "${def.name}" changed without waking the app`, {
        code: 'runtime/unmarked-resource-write',
        path: def.name,
        hint: 'Outside a frame, write resources with world.patchResource or world.touchResource (or call app.requestFrame()).',
      })
    }
  }
}
