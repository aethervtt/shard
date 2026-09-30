import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { ShardError } from '@aethervtt/shard-core'
import { bench } from './bench'
import {
  bake,
  type CommandContext,
  check,
  describe,
  docs,
  gen,
  importCommand,
  init,
  mcp,
  mv,
  run,
  screenshot,
  serve,
  testCommand,
  track,
  validate,
} from './commands'
import { dev } from './dev'
import { createOutput, EXIT, errorJson, formatError } from './output'
import { approve, capture, compare, perfCheck } from './verify'

const COMMANDS: Record<string, { run: (ctx: CommandContext) => Promise<number>; help: string }> = {
  init: {
    run: init,
    help: 'init <dir> [--template explorer|empty] [--name n]   scaffold a project',
  },
  validate: {
    run: validate,
    help: 'validate                        manifest and every scene; all errors',
  },
  import: {
    run: importCommand,
    help: 'import [--force]                import new and changed assets; list failures',
  },
  mv: { run: mv, help: 'mv <from> <to>                  move an asset and rewrite references' },
  check: {
    run: check,
    help: 'check                           type-check the project; file:line:col',
  },
  dev: {
    run: dev,
    help: 'dev [--port 5190]               run the project in a browser, hot reloading',
  },
  run: { run, help: 'run [--frames 600] [--scene p]   headless run; prints a world hash' },
  screenshot: {
    run: screenshot,
    help: 'screenshot <scene> --out f.png [--size WxH] [--frames N] [--camera path]',
  },
  gen: {
    run: gen,
    help: 'gen <generator|file> [--seed N | --seeds 1-9] [--param k=v] [--out sheet.png]',
  },
  bake: {
    run: bake,
    help: 'bake nav [--scene p] [--force]  bake navmeshes into .shard/cache/nav',
  },
  track: {
    run: track,
    help: 'track <scene.json> [--out f]     record a physics track; prints its hash',
  },
  test: { run: testCommand, help: 'test [pattern]                  gameplay tests in tests/' },
  bench: {
    run: bench,
    help: 'bench structure                  engine fixtures against their budgets (0055)',
  },
  capture: {
    run: capture,
    help: 'capture <plan.json> [--out dir]  browser captures, steps and records (0062)',
  },
  compare: {
    run: compare,
    help: 'compare [captures] [--approved dir] [--report f]   diff against approved images',
  },
  approve: {
    run: approve,
    help: 'approve <shot> --reason "…" [--captures dir] [--approved dir]',
  },
  'perf-check': {
    run: perfCheck,
    help: "perf-check <records...> --plan plan.json   fail on a plan's broken thresholds",
  },
  describe: {
    run: describe,
    help: 'describe                        plugins, systems, scenes, renderer, input',
  },
  docs: {
    run: docs,
    help: 'docs                            regenerate AGENTS.md block, .agents/, schemas',
  },
  serve: {
    run: serve,
    help: 'serve [--port 7811]             protocol hub: WebSocket + stdio JSON-RPC',
  },
  mcp: { run: mcp, help: 'mcp [--attach] [--port 7811]    MCP server for this project (stdio)' },
}

function usage(): string {
  return `shard <command> [--json] [--project <dir>]\n\n${Object.values(COMMANDS)
    .map((c) => `  shard ${c.help}`)
    .join('\n')}\n\nExit codes: 0 ok, 1 validation/test failure, 2 runtime error, 3 usage error.`
}

export async function main(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        json: { type: 'boolean' },
        project: { type: 'string' },
        template: { type: 'string' },
        name: { type: 'string' },
        force: { type: 'boolean' },
        frames: { type: 'string' },
        seed: { type: 'string' },
        scene: { type: 'string' },
        out: { type: 'string' },
        size: { type: 'string' },
        camera: { type: 'string' },
        port: { type: 'string' },
        seeds: { type: 'string' },
        param: { type: 'string', multiple: true },
        hub: { type: 'string' },
        attach: { type: 'boolean' },
        approved: { type: 'string' },
        captures: { type: 'string' },
        reason: { type: 'string' },
        report: { type: 'string' },
        plan: { type: 'string' },
        by: { type: 'string' },
        headed: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    })
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${usage()}\n`)
    return EXIT.usage
  }
  const [name, ...args] = parsed.positionals
  const out = createOutput(Boolean(parsed.values.json))
  const command = name ? COMMANDS[name] : undefined
  if (!command || parsed.values.help) {
    process.stderr.write(`${usage()}\n`)
    return command || parsed.values.help ? EXIT.ok : EXIT.usage
  }
  try {
    return await command.run({
      out,
      project: resolve((parsed.values.project as string | undefined) ?? '.'),
      args,
      flags: parsed.values as Record<string, string | boolean | undefined>,
    })
  } catch (err) {
    const usageError = err instanceof ShardError && err.code === 'cli/usage'
    if (out.json) process.stdout.write(`${JSON.stringify({ error: errorJson(err) }, null, 2)}\n`)
    process.stderr.write(`${formatError(err)}\n`)
    return usageError ? EXIT.usage : EXIT.runtime
  }
}
