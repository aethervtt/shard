import { defineSchema, t } from '@aethervtt/shard-core'
import type { AppMethod } from '@aethervtt/shard-runtime'
import {
  acquireAudioSnapshot,
  describeAudioMix,
  releaseAudioSnapshot,
  setAudioSnapshotWeight,
} from './mix'
import { audioState } from './mixer'
export const audioMixMethods: AppMethod[] = [
  {
    name: 'audio.mix.inspect',
    description: 'Inspect authored mixer, effective fields and snapshots.',
    params: defineSchema('audio/MixInspect', {}),
    handler: ({ world }) => describeAudioMix(world),
  },
  {
    name: 'audio.snapshot.acquire',
    description: 'Acquire an independently releasable snapshot handle.',
    params: defineSchema('audio/SnapshotAcquireParams', {
      asset: t.string({ required: true }),
      weight: t.f64({ default: 1, min: 0, max: 1 }),
    }),
    handler: async ({ world }, p) => ({
      snapshot: await acquireAudioSnapshot(world, p.asset as string, p.weight as number),
    }),
  },
  {
    name: 'audio.snapshot.set',
    description: 'Change one snapshot handle weight.',
    params: defineSchema('audio/SnapshotSetParams', {
      snapshot: t.u32({ required: true }),
      weight: t.f64({ min: 0, max: 1 }),
    }),
    handler: ({ world }, p) => {
      setAudioSnapshotWeight(world, p.snapshot as number, p.weight as number)
      return { updated: true }
    },
  },
  {
    name: 'audio.snapshot.release',
    description: 'Release one snapshot, preserving other handles and user settings.',
    params: defineSchema('audio/SnapshotReleaseParams', { snapshot: t.u32({ required: true }) }),
    handler: ({ world }, p) => ({ released: releaseAudioSnapshot(world, p.snapshot as number) }),
  },
  {
    name: 'audio.meters',
    description: 'Measured browser bus peak/RMS, or available:false on headless hosts.',
    params: defineSchema('audio/MetersParams', { bus: t.string({ default: 'master' }) }),
    handler: ({ world }, p) => audioState(world).backend.runtime!.meter(p.bus as string),
  },
]
