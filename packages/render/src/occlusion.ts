import { defineComponent, defineResource, type Entity, t, type World } from '@aethervtt/shard-core'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { Transform } from '@aethervtt/shard-transform'
import { Camera3d } from './camera'

// Occlusion culling (0116). The components and the depth buffer's tests are core; the occluder
// raster, the GPU upload and the cull variant are `occlusionPlugin`, which forwardPlugin includes.
// Without it, Occluder and OcclusionCulling log render/feature-missing once and cull nothing.

export const OcclusionCulling = defineComponent(
  'render/OcclusionCulling',
  {
    width: t.u16({
      default: 256,
      min: 16,
      max: 1024,
      description:
        "Width of the camera's occlusion buffer in pixels; its height follows the aspect.",
    }),
    range: t.f32({
      default: 200,
      min: 1,
      unit: 'm',
      description: 'Occluders farther than this from the camera are left out of its buffer.',
    }),
    shadows: t.bool({
      default: true,
      description:
        "Also drop dynamic casters from this camera's cascades when where their shadow falls is hidden.",
    }),
  },
  {
    description:
      'Culls what occluders hide from this camera (0116): occluders are rasterized on the CPU into a small depth buffer each frame, and draws behind it are skipped. For street-level views; a top-down camera gains nothing.',
    requires: [Camera3d],
  },
)

export const Occluder = defineComponent(
  'render/Occluder',
  {
    mesh: t.handle('Mesh', {
      description:
        "Triangles, in the entity's space, that lie inside what it draws: what it hides (a wall's solid spans, a hill's core). At most 256.",
    }),
  },
  {
    description:
      "What this entity hides from cameras with OcclusionCulling (0116). It follows the entity's visibility, render layers and each camera's ViewVisibility; a shadow-only or hidden entity hides nothing.",
    requires: [Transform],
  },
)

/** Triangles an occluder mesh may have; more log render/occluder-too-complex. */
export const MAX_OCCLUDER_TRIANGLES = 256

/**
 * A camera's occlusion buffer as the culls test it (0116); `occlusionPlugin` makes them. Each test
 * is conservative: true only when occluders surely hide it.
 */
export interface OcclusionTest {
  /** Its layer in the GPU copy, or -1. */
  readonly layer: number
  /** OcclusionCulling.shadows: the camera's cascades drop shadows that fall where it hides. */
  readonly shadows: boolean
  /** Batches and instances culled this frame by it (describe). */
  culledBatches: number
  culledInstances: number
  /** A world sphere. */
  hides(cx: number, cy: number, cz: number, r: number): boolean
  /**
   * An instance: its mesh's local box (`bounds`) through its affine rows at `o`, or for a skinned
   * slot its pose's `sphere`.
   */
  hidesInstance(
    rows: ArrayLike<number>,
    o: number,
    bounds: ArrayLike<number>,
    sphere: ArrayLike<number>,
    skinned: boolean,
  ): boolean
  /**
   * Where an instance's shadow can fall: it swept along `sweep` (the light's travel direction, then
   * the cascade's far side) down to `floor`, grown by `margin`.
   */
  hidesShadow(
    rows: ArrayLike<number>,
    o: number,
    bounds: ArrayLike<number>,
    sphere: ArrayLike<number>,
    skinned: boolean,
    sweep: ArrayLike<number>,
    margin: number,
    floor: number,
  ): boolean
}

/**
 * Set by `occlusionPlugin`: each occlusion camera's buffer for this frame, and the GPU copy the cull
 * reads. Core asks it per view, so it imports no raster code.
 */
export interface OcclusionSupport {
  /** The camera's buffer, rasterized this frame; undefined without OcclusionCulling. */
  bufferOf(camera: Entity): OcclusionTest | undefined
  /** The GPU copy of every camera's pyramid: a uniform of their projections, and the texture. */
  gpu(gpu: GpuContext): { uniform: GPUBuffer; texture: GPUTextureView } | undefined
}

export const OcclusionPath = defineResource<OcclusionSupport>('render/OcclusionPath', {
  description: 'Present when occlusion culling (occlusionPlugin) is installed.',
})

/**
 * Whether occluders hide a world sphere from `camera` in its last raster: for game code, such as
 * animating hidden characters less often. False without occlusionPlugin, OcclusionCulling, or a
 * raster yet. Allocation-free.
 */
export function occluded(
  world: World,
  camera: Entity,
  center: ArrayLike<number>,
  radius: number,
): boolean {
  const buffer = world.tryResource(OcclusionPath)?.bufferOf(camera)
  return buffer ? buffer.hides(center[0]!, center[1]!, center[2]!, radius) : false
}
