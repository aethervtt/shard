import type { Entity, World } from '@aethervtt/shard-core'
import { sampleCatmullRom } from '@aethervtt/shard-mesh'
import { type EditShape, type ShapeEdit, shapeGeometry } from './edits'
import { PREVIEW_POINTS } from './material'
import { heightfieldRuntime } from './queries'

/** What the terrain draws on the ground before an edit (spec 0104). */
export type TerrainPreview = (
  | { brush: { at: [number, number]; radius: number; falloff?: number } }
  | { edit: ShapeEdit }
) & {
  /** Linear RGB and the fill's opacity (default a light blue at 0.15). */
  color?: [number, number, number, number]
}

/** A preview as the material's uniforms take it. */
export interface PreviewState {
  version: number
  /** 0 none, 1 circle, 2 polygon, 3 path (an open polyline with a half width). */
  kind: number
  count: number
  /** A circle's radius, or a path's half width (m). */
  radius: number
  /** The second ring's distance from the outline (m): a falloff or wall outside, inner falloff inside. */
  ring: number
  color: [number, number, number, number]
  /** PREVIEW_POINTS (x, z) pairs in the terrain's frame. */
  points: Float32Array
}

const DEFAULT_COLOR: [number, number, number, number] = [0.35, 0.75, 1, 0.15]

/** Up to `max` points evenly along a polyline (closed: back to its start). */
function resample(points: [number, number][], closed: boolean, max: number): [number, number][] {
  if (points.length <= max) return points
  const n = points.length
  const segs = closed ? n : n - 1
  const lengths = [0]
  for (let i = 0; i < segs; i++) {
    const a = points[i]!
    const b = points[(i + 1) % n]!
    lengths.push(lengths[i]! + Math.hypot(b[0] - a[0], b[1] - a[1]))
  }
  const total = lengths[segs]!
  const out: [number, number][] = []
  const count = closed ? max : max - 1
  let s = 0
  for (let k = 0; k <= count; k++) {
    if (closed && k === count) break
    const at = (total * k) / count
    while (s < segs - 1 && lengths[s + 1]! < at) s++
    const a = points[s]!
    const b = points[(s + 1) % n]!
    const span = lengths[s + 1]! - lengths[s]!
    const t = span > 0 ? (at - lengths[s]!) / span : 0
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
  }
  return out
}

/** A shape's outline for the preview: kind, points, and a circle's radius or a path's half width. */
function outline(shape: EditShape): { kind: number; points: [number, number][]; radius: number } {
  shapeGeometry(shape, 0)
  if ('circle' in shape) return { kind: 1, points: [shape.circle.at], radius: shape.circle.radius }
  if ('rect' in shape) {
    const a = ((shape.rect.rotation ?? 0) * Math.PI) / 180
    const [cx, cz] = shape.rect.at
    const hw = shape.rect.size[0] / 2
    const hd = shape.rect.size[1] / 2
    // 0071's rectangles: the width axis is (cos, −sin) in (x, z), the depth axis (sin, cos).
    const u = [Math.cos(a) * hw, -Math.sin(a) * hw]
    const v = [Math.sin(a) * hd, Math.cos(a) * hd]
    return {
      kind: 2,
      points: [
        [cx - u[0]! - v[0]!, cz - u[1]! - v[1]!],
        [cx + u[0]! - v[0]!, cz + u[1]! - v[1]!],
        [cx + u[0]! + v[0]!, cz + u[1]! + v[1]!],
        [cx - u[0]! + v[0]!, cz - u[1]! + v[1]!],
      ],
      radius: 0,
    }
  }
  if ('polygon' in shape)
    return { kind: 2, points: resample(shape.polygon, true, PREVIEW_POINTS), radius: 0 }
  const flat = shape.spline.points.flatMap(([x, z]) => [x, 0, z])
  const pts = sampleCatmullRom(flat, false, 0.5)
  const line: [number, number][] = []
  for (let i = 0; i < pts.length; i += 3) line.push([pts[i]!, pts[i + 2]!])
  return { kind: 3, points: resample(line, false, PREVIEW_POINTS), radius: shape.spline.width / 2 }
}

/**
 * Shows a brush or a shape edit on the ground (spec 0104), or nothing with null: its outline, a
 * second ring (a brush's inner falloff, a shape's falloff or wall extent) and a tinted fill, drawn
 * by the terrain material on the drawn surface. Cheap to call every frame.
 */
export function terrainPreview(
  world: World,
  terrain: Entity,
  preview: TerrainPreview | null,
): void {
  const rt = heightfieldRuntime(world, terrain)
  let s = rt.parts.get('preview') as PreviewState | undefined
  if (!s) {
    s = {
      version: 0,
      kind: 0,
      count: 0,
      radius: 0,
      ring: 0,
      color: [...DEFAULT_COLOR],
      points: new Float32Array(PREVIEW_POINTS * 2),
    }
    rt.parts.set('preview', s)
  }
  s.version++
  s.points.fill(0)
  if (!preview) {
    s.kind = 0
    s.count = 0
    return
  }
  const color = preview.color ?? DEFAULT_COLOR
  for (let i = 0; i < 4; i++) s.color[i] = color[i]!
  if ('brush' in preview) {
    const b = preview.brush
    s.kind = 1
    s.count = 1
    s.radius = b.radius
    s.ring = -(b.falloff ?? 0.5) * b.radius
    s.points[0] = b.at[0]
    s.points[1] = b.at[1]
    return
  }
  const o = outline(preview.edit.shape)
  s.kind = o.kind
  s.count = o.points.length
  s.radius = o.radius
  s.ring = rt.edits ? rt.edits.reachOf(preview.edit) : 0
  o.points.forEach((p, i) => {
    s.points[i * 2] = p[0]
    s.points[i * 2 + 1] = p[1]
  })
}
