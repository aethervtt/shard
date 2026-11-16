# 0124 — Values shared with every worker

- **Status:** draft (built 2026-11-16). Implemented once its criteria pass in CI.
- **Packages:** `@aethervtt/shard-platform`, `@aethervtt/shard-platform-node`,
  `@aethervtt/shard-platform-web`
- **Depends on:** 0110 (worker pool), 0119 (worker tasks)

## Context

A generator often needs one large, read-only input that isn't a param: Risen's region plan
(14 MB: height grids, rivers, roads, towns) is read by every cell job. Today each worker thread
rebuilds it on its first job (8–17 s per thread), because nothing can put a value in every
worker. Passing it as a dependency copies it with every job, and a broadcast job can't reach
every thread, since the pool picks the thread.

## Goals

- `workers.share(key, value)`: every worker thread gets `value` once, before the next job the
  pool posts to it, including threads started later and threads that replace a crashed one.
- `workerShared<T>(key)`: in a worker (or inline, on the calling thread), the latest value shared
  under `key`, or `undefined`.
- Sharing again under the same key replaces the value; each thread receives it once more.

## Non-goals

- Shared memory (`SharedArrayBuffer` needs cross-origin isolation in browsers). The value is
  structured-cloned once per thread.
- Telling a thread to drop a value.

## Design

The pool keeps `shared: Map<key, { value, version }>` and, per slot, the version each key was
last sent at (cleared when the slot starts a new thread). Before posting a job to a thread, it
posts `{ share: key, value }` for each key the thread lacks or has an older version of. The
worker host stores it synchronously in a map on `globalThis[Symbol.for('shard.workerShared')]`
and posts no reply. Messages arrive in order, so the value is there before the job runs. The
inline pool writes the same map on the calling thread, so code reads `workerShared` the same way
with or without threads.

### API sketch

```ts
interface Workers {
  /** Sends `value` to every worker once, before its next job (0124). */
  share?(key: string, value: unknown): void
}
function workerShared<T>(key: string): T | undefined
```

### Agent surface

None.

## Decisions

- **Sent lazily, with the next job.** An idle thread gets nothing until it has work, and a
  thread that starts later needs no special path.
- **Optional on `Workers`.** Hosts with their own pool keep compiling; callers fall back to
  doing without.

## Acceptance criteria

- [ ] With a pool of 2, a value shared before 6 jobs is seen by every job, and posted to each
      thread exactly once.
- [ ] Sharing again under the same key: jobs after it see the new value.
- [ ] A thread that replaces a crashed one gets the value before its first job.
- [ ] The inline pool: `workerShared` returns the value on the calling thread.
