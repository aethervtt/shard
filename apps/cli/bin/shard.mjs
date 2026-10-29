#!/usr/bin/env node
// Projects are TypeScript, loaded as source by tests and headless runs: tsx handles them. In the
// repository the CLI runs from its own TypeScript too; published, it runs from dist (0093).
import { existsSync } from 'node:fs'
import { register } from 'tsx/esm/api'

register()
const source = new URL('../src/main.ts', import.meta.url)
const { main } = await import(existsSync(source) ? source.href : '../dist/main.js')
process.exitCode = await main(process.argv.slice(2))
