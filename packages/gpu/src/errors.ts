import { ShardError } from '@aethervtt/shard-core'

export type GpuErrorListener = (error: ShardError) => void

/** Turns a WebGPU error into a ShardError that names the object involved. */
export function toShardError(error: GPUError | Error, label: string | undefined): ShardError {
  const what = label ? `"${label}"` : 'an unlabeled GPU object'
  // The WebGL2 shim (0064) rejects with its own errors: keep their code and hint.
  if (error instanceof ShardError) {
    return new ShardError(error.code, `${error.message} (in ${what})`, {
      path: label,
      hint: error.hint,
      cause: error,
    })
  }
  // The shim's error classes have WebGPU's names; there's no GPUOutOfMemoryError global without WebGPU.
  const isOom =
    (typeof GPUOutOfMemoryError !== 'undefined' && error instanceof GPUOutOfMemoryError) ||
    (error as { name?: string }).name === 'GPUOutOfMemoryError'
  return new ShardError(
    isOom ? 'gpu/out-of-memory' : 'gpu/validation',
    `WebGPU error in ${what}: ${error.message}`,
    {
      path: label,
      hint: label ? undefined : 'Give every GPU object a label so errors can name it.',
    },
  )
}
