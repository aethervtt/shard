// shard bench <suite>: runs an engine suite's fixtures headless and checks them against their
// budgets. `structure` (0055) builds Aether's shadow-stress and max scenes.

import { ShardError } from '@aethervtt/shard-core'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import type { CommandContext } from './commands'
import { EXIT } from './output'

const SUITES = ['structure'] as const

export async function bench(ctx: CommandContext): Promise<number> {
  const suite = ctx.args[0]
  if (!suite || !(SUITES as readonly string[]).includes(suite)) {
    throw new ShardError('cli/usage', `Usage: shard bench <${SUITES.join('|')}>`, {
      hint: 'Run it on a machine doing nothing else: the budgets are exact.',
    })
  }
  const gpu = await createNodeGpuContext()
  try {
    ctx.out.say(`Running the ${suite} fixtures…`)
    const { runStructureBench } = await import('@aethervtt/shard-structure/bench')
    const results = await runStructureBench(gpu)
    const pass = results.every((r) => r.pass)
    const width = Math.max(...results.map((r) => r.name.length))
    const lines = results.map(
      (r) =>
        `${r.pass ? 'ok  ' : 'FAIL'} ${r.name.padEnd(width)}  ${format(r.value, r.unit)} (budget ${format(r.budget, r.unit)})`,
    )
    ctx.out.result({ suite, pass, results }, lines.join('\n'))
    return pass ? EXIT.ok : EXIT.failed
  } finally {
    gpu.destroy()
  }
}

function format(value: number, unit: string): string {
  return unit === 'ms' ? `${value.toFixed(2)} ms` : `${value} ${unit}`
}
