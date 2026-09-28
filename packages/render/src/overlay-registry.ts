import type { Entity, World } from '@aethervtt/shard-core'
import type { GizmoStore } from './gizmos'

// Overlays by name, so packages (physics, nav, animation) can register theirs without carrying the
// gizmo renderer; gizmosPlugin draws them.

export const OVERLAYS = [
  'bounds',
  'lights',
  'cameras',
  'cascades',
  'normals',
  'axes',
  'labels',
] as const
export type Overlay = (typeof OVERLAYS)[number]

/** An overlay another package draws (physics colliders, the navmesh, UI rects). */
export interface OverlayDef {
  name: string
  description: string
  /** Draws into gizmos. `passes(entity)` applies the overlay filter (components and path). */
  draw(world: World, g: GizmoStore, passes: (entity: Entity) => boolean): void
}

const extraOverlays = new Map<string, OverlayDef>()

/** Registers an overlay, so `debug.overlays` and `render.capture` can turn it on by name. */
export function defineOverlay(def: OverlayDef): OverlayDef {
  extraOverlays.set(def.name, def)
  return def
}

/** The registered overlays by name, read-only (no copy: drawOverlays reads it every frame). */
export function registeredOverlays(): ReadonlyMap<string, OverlayDef> {
  return extraOverlays
}

export function allOverlays(): OverlayDef[] {
  return [...extraOverlays.values()]
}

/** Every overlay name: the built-in ones, then registered ones. */
export function overlayNames(): string[] {
  return [...OVERLAYS, ...extraOverlays.keys()]
}
