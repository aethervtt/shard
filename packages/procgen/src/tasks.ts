import { ShardError } from '@aethervtt/shard-core'
import type { WorkerRunOptions } from '@aethervtt/shard-platform'
import { procgenHost } from './runtime'

// Worker tasks (spec 0119): functions other packages run on the generator worker module, which
// carries the project's code. A package registers its task when the project first uses it (a
// terrain generator's definition registers the terrain's), so the worker has it whenever it has
// that code. Nothing registers on import.

// biome-ignore lint/suspicious/noExplicitAny: tasks take whatever their package posts.
type Task = (...args: any[]) => unknown

const tasks = new Map<string, Task>()

/** Registers `fn` as the task `name` on this thread (again: replaces it). */
export function defineWorkerTask(name: string, fn: Task): void {
  tasks.set(name, fn)
}

/** Runs a task registered on this thread: what the worker module's `runTask` export does. */
export function runTask(name: string, args: readonly unknown[]): unknown {
  const task = tasks.get(name)
  if (!task) {
    throw new ShardError('procgen/unknown-task', `No worker task named "${name}" on this thread`, {
      hint: 'The worker module runs the project code that registers it: rebuild it (`shard dev` does on save), or check the host bundles `@aethervtt/shard-procgen/worker`’s runTask.',
    })
  }
  return task(...args)
}

/**
 * Runs a task on the host's pool, in the generator worker module (`configureProcgenHost`), or here
 * after an await when the host has no pool or module.
 */
export async function runWorkerTask<T>(
  name: string,
  args: readonly unknown[],
  options: WorkerRunOptions = {},
): Promise<T> {
  const host = procgenHost()
  const module = await host.workerModule
  if (host.workers && host.workers.size > 0 && module) {
    return host.workers.run<T>(module, 'runTask', [name, args], { kind: name, ...options })
  }
  await Promise.resolve()
  return runTask(name, args) as T
}

/** Whether tasks would run on a pool (the host has workers and a worker module). */
export function workerTasksPooled(): boolean {
  const host = procgenHost()
  return !!host.workers && host.workers.size > 0 && host.workerModule !== undefined
}
