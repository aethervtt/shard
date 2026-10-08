import { existsSync, readFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/**
 * Performance budgets as a Node host hands them to an app (0075; the runtime's `PerfBudgets`):
 * machines.json and budgets.json, where they came from, the CPU model, and `SHARD_MACHINE`.
 */
export interface NodePerfBudgets {
  machines: { machines: Record<string, Record<string, unknown>> }
  budgets: { spans: Record<string, Record<string, unknown>>; scenarios: Record<string, unknown> }
  source: string
  cpu: string | undefined
  machine?: string
}

/** The folder with machines.json and budgets.json: `<dir>/perf/`, or a `bench/perf/` above it. */
export function findPerfBudgets(from: string): string | undefined {
  const own = join(resolve(from), 'perf')
  if (existsSync(join(own, 'budgets.json')) && existsSync(join(own, 'machines.json'))) return own
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    const repo = join(dir, 'bench', 'perf')
    if (existsSync(join(repo, 'budgets.json')) && existsSync(join(repo, 'machines.json'))) {
      return repo
    }
    if (dirname(dir) === dir) return undefined
  }
}

/**
 * Loads a project's budgets (`perf/` in it) or the repo's (`bench/perf/`, found walking up from
 * `from`), for `app.insertResource(PerfBudgets, …)`. Undefined when there are none.
 */
export function loadPerfBudgets(
  from: string,
  env: Record<string, string | undefined> = process.env,
): NodePerfBudgets | undefined {
  const dir = findPerfBudgets(from)
  if (!dir) return undefined
  const read = (name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8'))
  return {
    machines: read('machines.json'),
    budgets: read('budgets.json'),
    source: join(dir, 'budgets.json'),
    cpu: cpus()[0]?.model,
    ...(env.SHARD_MACHINE ? { machine: env.SHARD_MACHINE } : {}),
  }
}
