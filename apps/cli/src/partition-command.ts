import { ShardError } from '@aethervtt/shard-core'
import type { CommandContext } from './commands'
import { withProject } from './commands'
import { localTarget } from './hub'
import { EXIT } from './output'

const USAGE =
  'Usage: shard partition gen [grid] --cell x,z [--level name] [--seed N] [--partition name] [--compare]'

/**
 * `shard partition gen [grid] --cell x,z [--level far] --seed N [--compare]` (0113): generates one
 * cell of a streamed partition in a fresh world and prints its hash, entity count and time. With
 * `--compare`, it also generates it inline, off the worker pool; the hashes must match.
 */
export async function partition(ctx: CommandContext): Promise<number> {
  const [mode, grid] = ctx.args
  const cellFlag = ctx.flags.cell as unknown
  const cell = Array.isArray(cellFlag) ? cellFlag[0] : cellFlag
  if (mode !== 'gen' || typeof cell !== 'string') throw new ShardError('cli/usage', USAGE)
  const [x, z] = cell.split(',').map(Number)
  if (!Number.isInteger(x) || !Number.isInteger(z)) throw new ShardError('cli/usage', USAGE)
  return withProject(ctx, { loadStartScene: false }, async (p) => {
    const local = localTarget('headless', p.server)
    const result = await local.request<{
      partition: string
      grid: string
      level: string
      hash: string
      entities: number
      ms: number
      inline?: string
    }>('partition.gen', {
      partition: typeof ctx.flags.partition === 'string' ? ctx.flags.partition : '',
      grid: grid ?? '',
      x,
      z,
      level: typeof ctx.flags.level === 'string' ? ctx.flags.level : '',
      seed: ctx.flags.seed === undefined ? 0 : Number(ctx.flags.seed),
      compare: ctx.flags.compare === true,
    })
    const same = result.inline === undefined || result.inline === result.hash
    ctx.out.result(
      result,
      `${result.partition} ${result.grid} ${x},${z} ${result.level}: ${result.hash.slice(0, 16)}… ${result.entities} entities in ${Math.round(result.ms)} ms${result.inline === undefined ? '' : same ? ', inline matches' : `, INLINE DIFFERS (${result.inline.slice(0, 16)}…)`}`,
    )
    return same ? EXIT.ok : EXIT.failed
  })
}
