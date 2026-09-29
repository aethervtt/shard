// pnpm bench: the ECS benchmarks, then every test file serially at the specs' exact budgets, with
// allocation checks on (SHARD_BENCH; see packages/core/src/test-env.ts). A script rather than an
// inline `SHARD_BENCH=1 ...` so it runs under Windows' shell too. Extra arguments go to turbo, e.g.
// `pnpm bench --filter=@aethervtt/shard-physics`.

import { spawnSync } from 'node:child_process'

function run(args, env = {}) {
  const result = spawnSync('pnpm', args, {
    stdio: 'inherit',
    // pnpm is a .cmd shim on Windows, which only a shell can start.
    shell: process.platform === 'win32',
    env: { ...process.env, ...env },
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

run(['--filter', '@aethervtt/shard-core', 'bench'])
run(['exec', 'turbo', 'run', 'test', '--concurrency=1', '--force', ...process.argv.slice(2)], {
  SHARD_BENCH: '1',
})
