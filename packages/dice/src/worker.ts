// `@aethervtt/shard-dice/worker` (0054): the dice worker entry, for `dicePlugin({ worker })`.

export { DICE_SETTLE_RULE, diceSettle } from './settle'

/**
 * The dice worker, bundled by the host's bundler (the `new Worker(new URL(…, import.meta.url))`
 * form Vite and webpack recognize): 0053's track server with `dice-settle` registered.
 */
export function diceWorker(): Worker {
  return new Worker(new URL('./dice-worker.ts', import.meta.url), { type: 'module' })
}
