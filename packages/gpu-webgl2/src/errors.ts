import { ShardError } from '@aethervtt/shard-core'

/** A call outside the subset WebGL2 runs (compute, a reinterpreting view): thrown, named. */
export function unsupported(what: string, hint?: string): ShardError {
  return new ShardError('gpu-webgl2/unsupported', `WebGL2 can't ${what}`, {
    hint:
      hint ??
      'The baseline tier (0064) keeps to what WebGL2 runs; see specs/0064-webgl2-fallback.md.',
  })
}

/** WebGPU's error classes, as error scopes and `uncapturederror` hand them out. */
export class ShimError extends Error {
  readonly kind: 'validation' | 'out-of-memory' | 'internal'
  constructor(kind: 'validation' | 'out-of-memory' | 'internal', message: string) {
    super(message)
    this.kind = kind
    this.name =
      kind === 'validation'
        ? 'GPUValidationError'
        : kind === 'out-of-memory'
          ? 'GPUOutOfMemoryError'
          : 'GPUInternalError'
  }
}
