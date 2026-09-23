#!/usr/bin/env node
// The CLI and project code are TypeScript; tsx loads both without a build step.
import { register } from 'tsx/esm/api'

register()
const { main } = await import('../src/main.ts')
process.exitCode = await main(process.argv.slice(2))
