// The worker module generator jobs run in (see procgen.ts): the playground's generators plus the
// procgen job runner. Vite serves it transformed, so web workers import it as is.
import './procgen-generators'

export { runGeneratorJob, warmUp } from '@shard/procgen/worker'
