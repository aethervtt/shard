import { defineResource } from '@aethervtt/shard-core'

/**
 * The frame demand a renderer holds while a frame skipped draws (pipelines compiling, meshes or
 * materials still loading, 0052). Such a frame isn't complete: traces and the first usable frame
 * wait for one that is (0062).
 */
export const LOADING_DEMAND = 'render/loading'

/** How the app's frames are driven: every display refresh, only when needed, or by hand. */
export type FrameMode = 'continuous' | 'on-demand' | 'manual'

/**
 * What keeps an on-demand runner rendering (0052). Holders are named, so `render.describe` can say
 * who is keeping frames running: awake physics bodies, live particles, playing animations, the
 * RenderScale controller while probing, or anything a game holds itself.
 */
export class FrameDemandState {
  /** Set by the runner. 'manual' until a loop runner starts. */
  mode: FrameMode = 'manual'
  /** Clock time (ms, the app's clock) of the earliest frame `after` asked for; Infinity if none. */
  dueAt = Number.POSITIVE_INFINITY
  /** Set by the on-demand runner: called when a new demand appears, so an idle runner wakes. */
  onDemand: (() => void) | undefined = undefined
  private readonly holders = new Set<string>()
  private readonly now: () => number

  constructor(now: () => number = () => performance.now()) {
    this.now = now
  }

  /** Keeps frames running until `release(key)`. Holding a key twice is one hold. */
  hold(key: string): void {
    if (this.holders.has(key)) return
    this.holders.add(key)
    this.onDemand?.()
  }

  release(key: string): void {
    this.holders.delete(key)
  }

  /** Holds `key` while `on` is true: one call per frame from a system that tracks a condition. */
  set(key: string, on: boolean): void {
    if (on) this.hold(key)
    else this.holders.delete(key)
  }

  /** Asks for one frame `ms` from now, for ambient loops at low rates. The earliest ask wins. */
  after(ms: number): void {
    const at = this.now() + Math.max(0, ms)
    if (at >= this.dueAt) return
    this.dueAt = at
    this.onDemand?.()
  }

  /** Ms until the frame `after` asked for (0 if overdue); Infinity if none was asked for. */
  dueIn(): number {
    return this.dueAt === Number.POSITIVE_INFINITY
      ? this.dueAt
      : Math.max(0, this.dueAt - this.now())
  }

  /** @internal The runner calls this as a frame starts: a frame that was due is now running. */
  takeDue(): void {
    if (this.dueAt <= this.now() + 1) this.dueAt = Number.POSITIVE_INFINITY
  }

  /** Whether anything holds frames running. */
  get active(): boolean {
    return this.holders.size > 0
  }

  isHeld(key: string): boolean {
    return this.holders.has(key)
  }

  /** The keys holding frames running, sorted. */
  held(): string[] {
    return [...this.holders].sort()
  }

  /** The runner's mode, what holds frames, and when the next timed frame is due. For agents. */
  describe(): { mode: FrameMode; demands: string[]; dueInMs: number | null } {
    const due = this.dueIn()
    return { mode: this.mode, demands: this.held(), dueInMs: due === Infinity ? null : due }
  }
}

export const FrameDemand = defineResource<FrameDemandState>('core/FrameDemand', {
  description:
    'What keeps an on-demand runner rendering: hold(key) / release(key) while something must run each frame, after(ms) for one frame later.',
})
