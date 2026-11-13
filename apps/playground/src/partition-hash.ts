// The 0113 hash check in a browser: the test town's cells at both levels, generated here. The
// browser test reads `partitionHashes` and compares it with the hashes Node makes.
import { World } from '@aethervtt/shard-core'
import { cellHashOf } from '@aethervtt/shard-partition'
import { defineTown, ENGINE_COMPONENTS, HASH_CELLS } from '@aethervtt/shard-partition/testing'

void ENGINE_COMPONENTS
const town = defineTown({ name: 'hash-town', props: 4 })

async function run(): Promise<void> {
  const world = new World()
  const out: string[] = []
  for (const [x, z, level] of HASH_CELLS) out.push(await cellHashOf(world, town, 7, 0, x, z, level))
  ;(globalThis as { partitionHashes?: string[] }).partitionHashes = out
  document.getElementById('out')!.textContent = HASH_CELLS.map(
    ([x, z, level], i) => `${x},${z} ${level.padEnd(4)} ${out[i]}`,
  ).join('\n')
}

run().catch((err: unknown) => {
  ;(globalThis as { partitionHashError?: string }).partitionHashError = String(err)
  document.getElementById('out')!.textContent = String(err)
})
