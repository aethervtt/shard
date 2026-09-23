import { ShardError } from '@shard/core'

export type GpuErrorListener = (error: ShardError) => void

/** Turns a WebGPU error into a ShardError that names the object involved. */
export function toShardError(error: GPUError | Error, label: string | undefined): ShardError {
  const what = label ? `"${label}"` : 'an unlabeled GPU object'
  const isOom = typeof GPUOutOfMemoryError !== 'undefined' && error instanceof GPUOutOfMemoryError
  return new ShardError(
    isOom ? 'gpu/out-of-memory' : 'gpu/validation',
    `WebGPU error in ${what}: ${error.message}`,
    {
      path: label,
      hint: label ? undefined : 'Give every GPU object a label so errors can name it.',
    },
  )
}
