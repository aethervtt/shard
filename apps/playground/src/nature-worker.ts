// The worker module the trees demo's generator jobs run in (see nature.ts): the nature package
// (its generator and species type) plus the procgen job runner.
import '@aethervtt/shard-nature'

export { buildProxy, runGeneratorJob, warmUp } from '@aethervtt/shard-procgen/worker'
