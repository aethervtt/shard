// A track worker for the Node tests: `worker_threads` instead of a web worker, plus a `crash` rule
// whose recording throws where nothing catches it, as a worker bug would.

import { parentPort } from 'node:worker_threads'
import { serveTracks } from './serve'

const port = parentPort!

serveTracks({
  rules: {
    crash: () => () => {
      setTimeout(() => {
        throw new Error('boom')
      })
      return 'continue'
    },
  },
  scope: {
    postMessage: (message, transfer) => port.postMessage(message, transfer as ArrayBuffer[]),
    addEventListener: (_type, listener) => port.on('message', (data) => listener({ data })),
    close: () => port.close(),
  },
})
