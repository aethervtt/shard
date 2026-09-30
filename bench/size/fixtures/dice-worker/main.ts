// dice-worker (0054): what the dice worker runs, the entry `diceWorker()` starts: 0053's track
// server with the dice-settle rule. budgets.json forbids renderer and GPU code in it: dice record
// where neither exists, and the worker must stay small to start fast.
import { DICE_SETTLE_RULE, diceSettle } from '@aethervtt/shard-dice/worker'
import { serveTracks } from '@aethervtt/shard-physics/worker'

serveTracks({ rules: { [DICE_SETTLE_RULE]: diceSettle } })
