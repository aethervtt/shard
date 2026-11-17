import { ShardError } from '@aethervtt/shard-core'

/**
 * Every binding of forward's view group (group 0), in one table: a feature that adds one to the
 * view group takes its number here, so no two collide (0129's refraction and 0131's cloud shadows
 * both took 19 once). `checkViewEntries` throws on a duplicate when a layout is built anyway.
 */
export const VIEW_BINDINGS = {
  view: 0,
  lights: 1,
  clusters: 2,
  directional: 3,
  shadowData: 4,
  cascades: 5,
  spotShadows: 6,
  pointShadows: 7,
  shadowSampler: 8,
  specular: 9,
  brdfLut: 10,
  environmentSampler: 11,
  sh: 12,
  environmentSource: 13,
  globals: 14,
  /** SSAO; the refraction pass leaves it out. */
  ao: 15,
  /** Interior lighting (0069), while a mode is on. */
  interiorData: 16,
  interiorTable: 17,
  shaderData: 18,
  /** Sky occlusion's map (0131), while the hook is on. */
  skyOcclusion: 19,
  /** The refraction pass's opaque copy (0129). */
  refractionColor: 20,
  refractionDepth: 21,
} as const

/** Throws `render/view-binding-collision` when two of a view layout's entries share a binding. */
export function checkViewEntries(label: string, entries: readonly GPUBindGroupLayoutEntry[]): void {
  for (let i = 1; i < entries.length; i++) {
    for (let j = 0; j < i; j++) {
      if (entries[i]!.binding !== entries[j]!.binding) continue
      const name = Object.keys(VIEW_BINDINGS).find(
        (k) => VIEW_BINDINGS[k as keyof typeof VIEW_BINDINGS] === entries[i]!.binding,
      )
      throw new ShardError(
        'render/view-binding-collision',
        `View layout "${label}" has two entries at binding ${entries[i]!.binding}${name ? ` (${name})` : ''}`,
        {
          hint: 'Take a binding of the view group from VIEW_BINDINGS (view-bindings.ts), and add new ones there.',
        },
      )
    }
  }
}
