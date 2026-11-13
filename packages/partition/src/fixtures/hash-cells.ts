// Prints the test town's cell hashes as JSON: a second process for the 0112 hash criterion.
// tsx src/fixtures/hash-cells.ts '[[x, z, "full"], …]'
import { World } from '@aethervtt/shard-core'
import { cellHashOf } from '../methods'
import { ENGINE_COMPONENTS } from './engine-components'
import { defineTown } from './town'

void ENGINE_COMPONENTS

const town = defineTown({ name: 'hash-town', props: 4 })
const cells = JSON.parse(process.argv[2] ?? '[]') as [number, number, string][]
const world = new World()
const out: string[] = []
for (const [x, z, level] of cells) out.push(await cellHashOf(world, town, 7, 0, x, z, level))
process.stdout.write(JSON.stringify(out))
