// The dice worker (0054): 0053's track server with the `dice-settle` rule registered. `diceWorker()`
// from `@aethervtt/shard-dice/worker` starts it; the host's bundler bundles it with Rapier.

import { serveTracks } from '@aethervtt/shard-physics/worker'
import { DICE_SETTLE_RULE, diceSettle } from './settle'

serveTracks({ rules: { [DICE_SETTLE_RULE]: diceSettle } })
