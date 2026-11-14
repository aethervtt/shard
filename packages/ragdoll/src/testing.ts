/**
 * Stand-in rest clips for tests and demos (0117): lying on the back and front, and crude get-ups
 * from each, made from a skeleton's rest pose by turning its top joint. Real games author these.
 */
import { type AnimationClipAsset, AnimationClips } from '@aethervtt/shard-animation'
import type { AssetRef, JsonObject, World } from '@aethervtt/shard-core'
import type { SkinAsset } from '@aethervtt/shard-render'
import { RagdollClipNames } from './sim'

export interface RestClipOptions {
  /** The top joint's height lying, as a share of its rest height (default 0.13). */
  lying?: number
  /** The get-ups' length, s (default 1.6). */
  duration?: number
}

function rotX(angle: number, q: readonly number[]): number[] {
  const s = Math.sin(angle / 2)
  const c = Math.cos(angle / 2)
  // (c, s, 0, 0)·q in xyzw.
  const [x, y, z, w] = q as [number, number, number, number]
  return [c * x + s * w, c * y - s * z, c * z + s * y, c * w - s * x]
}

function channel(
  target: string,
  field: 'rotation' | 'translation',
  times: number[],
  values: number[][],
) {
  return {
    target,
    component: 'core/Transform',
    field,
    interpolation: 'linear' as const,
    times: Float32Array.from(times),
    values: Float32Array.from(values.flat()),
    width: field === 'rotation' ? 4 : 3,
  }
}

/**
 * lie_back, lie_front, getup_back and getup_front on `skin`'s skeleton (y up, facing +z): its top
 * joint turned a quarter about x and lowered, the get-ups rising through a half-turn crouch. Only
 * the top joint is keyed; everything else holds its rest.
 */
export function restClips(
  skin: SkinAsset,
  options: RestClipOptions = {},
): Record<string, AnimationClipAsset> {
  const top = skin.joints.findIndex(
    (p) => !skin.joints.some((o) => o !== p && p.startsWith(`${o}/`)),
  )
  const path = skin.joints[top]!
  const rest = skin.restPose[top]!
  const r = rest.rotation
  const t = rest.translation
  const low = t[1]! * (options.lying ?? 0.13)
  const mid = t[1]! * 0.45
  const d = options.duration ?? 1.6
  const pose = (name: string, angle: number): AnimationClipAsset => ({
    name,
    duration: 1,
    channels: [
      channel(path, 'rotation', [0, 1], [rotX(angle, r), rotX(angle, r)]),
      channel(
        path,
        'translation',
        [0, 1],
        [
          [t[0]!, low, t[2]!],
          [t[0]!, low, t[2]!],
        ],
      ),
    ],
    events: [],
  })
  const getUp = (name: string, angle: number): AnimationClipAsset => ({
    name,
    duration: d,
    channels: [
      channel(path, 'rotation', [0, d * 0.45, d], [rotX(angle, r), rotX(angle * 0.5, r), [...r]]),
      channel(
        path,
        'translation',
        [0, d * 0.45, d],
        [[t[0]!, low, t[2]!], [t[0]!, mid, t[2]!], [...t]],
      ),
    ],
    events: [],
  })
  return {
    lie_back: pose('lie_back', -Math.PI / 2),
    lie_front: pose('lie_front', Math.PI / 2),
    getup_back: getUp('getup_back', -Math.PI / 2),
    getup_front: getUp('getup_front', Math.PI / 2),
  }
}

/** Adds restClips to the clip store and registers them by name for ragdoll rests. */
export function registerRestClips(
  world: World,
  skin: SkinAsset,
  options: RestClipOptions = {},
): Map<string, AssetRef<'AnimationClip'>> {
  const clips = world.resource(AnimationClips)
  const names = world.resource(RagdollClipNames)
  const out = new Map<string, AssetRef<'AnimationClip'>>()
  for (const [name, clip] of Object.entries(restClips(skin, options))) {
    const ref = clips.add(clip, name) as AssetRef<'AnimationClip'>
    names.set(name, ref)
    out.set(name, ref)
  }
  return out
}

/** The rests restClips makes, for a ragdoll asset's `rests`. */
export const HUMANOID_RESTS: JsonObject = {
  'lie-back': { from: 'front', pose: 'lie_back', getUp: 'getup_back' },
  'lie-front': { from: 'back', pose: 'lie_front', getUp: 'getup_front' },
}
