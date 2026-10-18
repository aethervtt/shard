import { ShardError } from '@aethervtt/shard-core'

/** Shared validation for authored data and imperative calls. */
export function audioNumber(
  value: number,
  path: string,
  min = 0,
  max = Number.POSITIVE_INFINITY,
): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new ShardError('audio/invalid-range', `${path} must be finite and in [${min}, ${max}]`, {
      path,
      hint: 'Use a finite value in the declared range and units.',
    })
  }
}

export function audioRange(min: number, max: number, pitch: boolean, path: string): void {
  audioNumber(min, path, pitch ? Number.MIN_VALUE : 0)
  audioNumber(max, path, min)
}

export function audioLoop(start: number, end: number, duration: number): void {
  audioNumber(start, '/loopStart', 0, duration)
  audioNumber(end, '/loopEnd', 0, duration)
  if (duration > 0 && start >= (end || duration)) {
    throw new ShardError('audio/invalid-range', 'The loop start must precede its end', {
      path: '/loopStart',
      hint: 'Set 0 ≤ loopStart < loopEnd ≤ duration; loopEnd 0 means duration.',
    })
  }
}
