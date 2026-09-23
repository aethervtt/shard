import { defineResource } from '@shard/core'

/**
 * Frame control shared by every runner: pause, resume, and step exactly N frames. Stepped frames
 * use the fixed delta, so seeded runs stay deterministic under stepping.
 */
export class AppControl {
  paused = false
  /** Stepped frames ever requested / ever run. Both only grow; the difference is what's pending. */
  private requested = 0
  private completed = 0
  private waiters: { target: number; resolve: () => void }[] = []

  get pendingSteps(): number {
    return this.requested - this.completed
  }

  /** Pauses the app and queues `frames` stepped frames; resolves once they've run. */
  step(frames: number): Promise<void> {
    this.paused = true
    if (frames <= 0) return Promise.resolve()
    this.requested += frames
    const target = this.requested
    return new Promise((resolve) => this.waiters.push({ target, resolve }))
  }

  /** @internal Runners call this after running one stepped frame. */
  stepped(): void {
    if (this.pendingSteps === 0) return
    this.completed++
    while (this.waiters.length > 0 && this.waiters[0]!.target <= this.completed) {
      this.waiters.shift()!.resolve()
    }
  }
}

export const AppControlResource = defineResource<AppControl>('core/AppControl', {
  description: 'Pause, resume, and step the app. Runners honor it every frame.',
})
