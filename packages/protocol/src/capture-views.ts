import { defineResource, type Entity, type World } from '@aethervtt/shard-core'

/** An image a plugin draws of its own data for `render.capture { debug }` (0097: 'water-info'). */
export interface CaptureDebugView {
  /** What the image shows, for errors that list the views. */
  description: string
  /** Renders it for a camera; RGBA8, row by row. */
  capture(
    world: World,
    camera: Entity,
  ): Promise<{ width: number; height: number; data: Uint8Array }>
}

/**
 * Debug views plugins add to `render.capture` by name, next to the renderer's own ('clusters',
 * 'cascades', 'lod', 'culling', 'shadow-map:…').
 */
export const CaptureDebugViews = defineResource<Map<string, CaptureDebugView>>(
  'protocol/CaptureDebugViews',
  {
    description: "Debug views plugins add to render.capture's debug parameter, by name.",
    init: () => new Map(),
  },
)
