// The dice worker for the Node tests: the same server on `worker_threads`, through tsx.

import { parentPort } from 'node:worker_threads'
import { serveTracks } from '@aethervtt/shard-physics/worker'
import { DICE_SETTLE_RULE, diceSettle } from './settle'

const port = parentPort!

serveTracks({
  rules: { [DICE_SETTLE_RULE]: diceSettle },
  scope: {
    postMessage: (message, transfer) => port.postMessage(message, transfer as ArrayBuffer[]),
    addEventListener: (_type, listener) => port.on('message', (data) => listener({ data })),
    close: () => port.close(),
  },
})
