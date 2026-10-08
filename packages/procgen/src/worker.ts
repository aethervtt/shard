// The worker side of generator jobs. Hosts bundle this with the project's code (so its generators
// are defined) into one self-contained module and hand its URL to `configureProcgenHost`.
import { ENGINE_GENERATORS } from './engine/generators'
import { executeJob, type GenJob } from './job'
import { encodeRecord } from './record'

/**
 * Runs one generator job with the clock and Math.random guarded for all of it. The result is one
 * packed record (`encodeRecord`), so its bytes move back to the caller instead of being copied.
 */
export async function runGeneratorJob(job: GenJob): Promise<{ packed: Uint8Array }> {
  const result = await executeJob({ ...job, guardAll: true })
  return { packed: encodeRecord({ key: '', ...result, bytes: 0 }) }
}

/** Nothing: loading this module (the engine's generators and the project's code) is the point. */
export function warmUp(): boolean {
  return ENGINE_GENERATORS.length > 0
}
