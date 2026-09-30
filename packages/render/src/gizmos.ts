import { defineResource, defineSystem, mat4, type World } from '@aethervtt/shard-core'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { Time } from '@aethervtt/shard-runtime'
import { DataStore, dataEntry } from './data-store'
import { ForwardStateResource } from './forward'
import { LABEL_FONT, labelAtlas, labelWidth } from './gizmo-font'
import { type NodeContext, type NodeDescriptor, RenderPhase, type RenderView } from './graph'
import { Gpu, Shaders } from './plugin'
import { depthReadEntry } from './tier'
import { cameraOf } from './view'

/**
 * Immediate-mode debug drawing. Any system calls `world.resource(Gizmos).line(…)` and the line
 * shows for this frame (or for `duration` seconds). Calls append to typed arrays: nothing is
 * allocated per call once the arrays have grown to the frame's count.
 */
export interface GizmoOptions {
  /** Seconds to keep drawing it (0: this frame only). */
  duration?: number
  /** Hide behind geometry (drawn dimmed where occluded). Default true for shapes, false for labels. */
  depthTest?: boolean
  /** Line width in pixels. Default 1.5. */
  width?: number
}

/** Line records: a (3), b (3), color (rgba8), meta (bit 0: no depth test, bits 8+: width × 8). */
export const GIZMO_LINE_FLOATS = 8
/** Label glyph records: anchor (3), offset (2), pad, size (2), glyph, color, meta, pad. */
const GLYPH_FLOATS = 12
const SOLID = 0xffffffff
const NO_DEPTH = 1
/** Defaults: shapes depth-tested at 1.5 px, labels on top. */
const LINE_META = 12 << 8
const LABEL_META = NO_DEPTH | (12 << 8)

const packScratch = new Uint8Array(4)
const packView = new Uint32Array(packScratch.buffer)

/** Linear RGBA (0–1) to rgba8. */
export function packGizmoColor(c: ArrayLike<number>): number {
  packScratch[0] = Math.round(Math.min(1, Math.max(0, c[0] ?? 1)) * 255)
  packScratch[1] = Math.round(Math.min(1, Math.max(0, c[1] ?? 1)) * 255)
  packScratch[2] = Math.round(Math.min(1, Math.max(0, c[2] ?? 1)) * 255)
  packScratch[3] = Math.round(Math.min(1, Math.max(0, c[3] ?? 1)) * 255)
  return packView[0]!
}

function unpackColor(v: number): [number, number, number, number] {
  packView[0] = v
  return [
    packScratch[0]! / 255,
    packScratch[1]! / 255,
    packScratch[2]! / 255,
    packScratch[3]! / 255,
  ]
}

/** Lines and labels of one lifetime (this frame, or timed). */
class GizmoList {
  lines = new Float32Array(GIZMO_LINE_FLOATS * 256)
  lineBits = new Uint32Array(this.lines.buffer)
  lineCount = 0
  /** Timed lists: when each line stops drawing (Time.elapsed). */
  lineExpiry = new Float64Array(256)
  labelPos = new Float32Array(3 * 16)
  labelColor = new Uint32Array(16)
  labelMeta = new Uint32Array(16)
  labelText: string[] = []
  labelExpiry = new Float64Array(16)
  labelCount = 0

  /** Appends a line; returns its index. */
  line(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    color: number,
    meta: number,
  ): number {
    if (this.lineCount * GIZMO_LINE_FLOATS >= this.lines.length) {
      const grown = new Float32Array(this.lines.length * 2)
      grown.set(this.lines)
      this.lines = grown
      this.lineBits = new Uint32Array(grown.buffer)
      const e = new Float64Array(this.lineExpiry.length * 2)
      e.set(this.lineExpiry)
      this.lineExpiry = e
    }
    const o = this.lineCount * GIZMO_LINE_FLOATS
    const f = this.lines
    f[o] = ax
    f[o + 1] = ay
    f[o + 2] = az
    f[o + 3] = bx
    f[o + 4] = by
    f[o + 5] = bz
    this.lineBits[o + 6] = color
    this.lineBits[o + 7] = meta
    return this.lineCount++
  }

  label(
    x: number,
    y: number,
    z: number,
    text: string,
    color: number,
    meta: number,
    expiry: number,
  ): void {
    const n = this.labelCount
    if (n >= this.labelColor.length) {
      const pos = new Float32Array(this.labelPos.length * 2)
      pos.set(this.labelPos)
      this.labelPos = pos
      const col = new Uint32Array(this.labelColor.length * 2)
      col.set(this.labelColor)
      this.labelColor = col
      const meta2 = new Uint32Array(this.labelMeta.length * 2)
      meta2.set(this.labelMeta)
      this.labelMeta = meta2
      const e = new Float64Array(this.labelExpiry.length * 2)
      e.set(this.labelExpiry)
      this.labelExpiry = e
    }
    this.labelPos[n * 3] = x
    this.labelPos[n * 3 + 1] = y
    this.labelPos[n * 3 + 2] = z
    this.labelColor[n] = color
    this.labelMeta[n] = meta
    this.labelText[n] = text
    this.labelExpiry[n] = expiry
    this.labelCount++
  }

  /** Drops entries whose expiry has passed, keeping the order of the rest. */
  expire(now: number): void {
    let w = 0
    for (let r = 0; r < this.lineCount; r++) {
      if (this.lineExpiry[r]! <= now) continue
      if (w !== r) {
        this.lines.copyWithin(
          w * GIZMO_LINE_FLOATS,
          r * GIZMO_LINE_FLOATS,
          (r + 1) * GIZMO_LINE_FLOATS,
        )
        this.lineExpiry[w] = this.lineExpiry[r]!
      }
      w++
    }
    this.lineCount = w
    w = 0
    for (let r = 0; r < this.labelCount; r++) {
      if (this.labelExpiry[r]! <= now) continue
      if (w !== r) {
        this.labelPos.copyWithin(w * 3, r * 3, r * 3 + 3)
        this.labelColor[w] = this.labelColor[r]!
        this.labelMeta[w] = this.labelMeta[r]!
        this.labelText[w] = this.labelText[r]!
        this.labelExpiry[w] = this.labelExpiry[r]!
      }
      w++
    }
    this.labelCount = w
    this.labelText.length = w
  }

  clear(): void {
    this.lineCount = 0
    this.labelCount = 0
  }

  /** Adds an offset to every line end and label anchor (a floating-origin shift). */
  shift(x: number, y: number, z: number): void {
    const f = this.lines
    for (let i = 0; i < this.lineCount; i++) {
      const o = i * GIZMO_LINE_FLOATS
      f[o] = f[o]! + x
      f[o + 1] = f[o + 1]! + y
      f[o + 2] = f[o + 2]! + z
      f[o + 3] = f[o + 3]! + x
      f[o + 4] = f[o + 4]! + y
      f[o + 5] = f[o + 5]! + z
    }
    const p = this.labelPos
    for (let i = 0; i < this.labelCount; i++) {
      p[i * 3] = p[i * 3]! + x
      p[i * 3 + 1] = p[i * 3 + 1]! + y
      p[i * 3 + 2] = p[i * 3 + 2]! + z
    }
  }
}

const m4 = new Float32Array(16)
const rot = new Float32Array(9)
const corners = new Float32Array(24)
const BOX_EDGES = [0, 1, 1, 3, 3, 2, 2, 0, 4, 5, 5, 7, 7, 6, 6, 4, 0, 4, 1, 5, 2, 6, 3, 7]
const CIRCLE_SEGMENTS = 32

export class GizmoStore {
  /** Drawn this frame; cleared at the start of the next. */
  readonly frame = new GizmoList()
  /** Drawn with a duration; kept until they expire. */
  readonly timed = new GizmoList()
  /**
   * Built-in overlays (overlays.ts), redrawn by their system each render. Their own list, so a
   * render without a full frame (a capture of a paused game) doesn't draw them twice.
   */
  readonly overlay = new GizmoList()
  /** Where frame-lifetime drawings go: `frame`, or `overlay` while overlays draw. */
  private current = this.frame

  /** Routes drawings to the overlay list until `endOverlays`, clearing it first. */
  beginOverlays(): void {
    this.overlay.clear()
    this.current = this.overlay
  }

  endOverlays(): void {
    this.current = this.frame
  }

  /** Time.elapsed at the start of this frame. */
  now = 0
  /** Every list, in draw order. */
  readonly lists: readonly GizmoList[] = [this.frame, this.overlay, this.timed]

  // The last color packed, so a run of lines in one color packs it once.
  private lr = -1
  private lg = -1
  private lb = -1
  private la = -1
  private lp = 0

  private pack(c: ArrayLike<number>): number {
    const r = c[0]!
    const g = c[1]!
    const b = c[2]!
    const a = c[3] ?? 1
    if (r !== this.lr || g !== this.lg || b !== this.lb || a !== this.la) {
      this.lr = r
      this.lg = g
      this.lb = b
      this.la = a
      this.lp = packGizmoColor(c)
    }
    return this.lp
  }

  private meta(options: GizmoOptions | undefined, labels: boolean): number {
    if (options === undefined) return labels ? LABEL_META : LINE_META
    const depthTest = options.depthTest ?? !labels
    const width = options.width ?? 1.5
    return (depthTest ? 0 : NO_DEPTH) | (Math.min(255, Math.round(width * 8)) << 8)
  }

  private list(options: GizmoOptions | undefined): GizmoList {
    return options?.duration ? this.timed : this.current
  }

  /** Timed lines from `first` on get their expiry. */
  private expire(options: GizmoOptions | undefined, list: GizmoList, first: number): void {
    if (list !== this.timed) return
    const until = this.now + options!.duration!
    for (let i = first; i < list.lineCount; i++) list.lineExpiry[i] = until
  }

  /** A segment from a to b. Colors are linear RGBA from 0 to 1. */
  line(
    a: ArrayLike<number>,
    b: ArrayLike<number>,
    color: ArrayLike<number>,
    options?: GizmoOptions,
  ): void {
    if (options === undefined) {
      this.current.line(a[0]!, a[1]!, a[2]!, b[0]!, b[1]!, b[2]!, this.pack(color), LINE_META)
      return
    }
    const list = this.list(options)
    const i = list.line(
      a[0]!,
      a[1]!,
      a[2]!,
      b[0]!,
      b[1]!,
      b[2]!,
      this.pack(color),
      this.meta(options, false),
    )
    this.expire(options, list, i)
  }

  /** A line with an arrowhead at `to`. */
  arrow(
    from: ArrayLike<number>,
    to: ArrayLike<number>,
    color: ArrayLike<number>,
    options?: GizmoOptions,
  ): void {
    const list = this.list(options)
    const c = this.pack(color)
    const meta = this.meta(options, false)
    const first = list.lineCount
    const tx = to[0]!
    const ty = to[1]!
    const tz = to[2]!
    const dx = tx - from[0]!
    const dy = ty - from[1]!
    const dz = tz - from[2]!
    list.line(from[0]!, from[1]!, from[2]!, tx, ty, tz, c, meta)
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (len < 1e-9) {
      this.expire(options, list, first)
      return
    }
    const head = Math.min(len * 0.25, Math.max(len * 0.1, 0.1))
    const fx = dx / len
    const fy = dy / len
    const fz = dz / len
    // Two axes perpendicular to the shaft.
    let ux = Math.abs(fy) < 0.9 ? 0 : 1
    let uy = Math.abs(fy) < 0.9 ? 1 : 0
    let uz = 0
    const rx = fy * uz - fz * uy
    const ry = fz * ux - fx * uz
    const rz = fx * uy - fy * ux
    const rl = Math.sqrt(rx * rx + ry * ry + rz * rz)
    const sx = rx / rl
    const sy = ry / rl
    const sz = rz / rl
    ux = sy * fz - sz * fy
    uy = sz * fx - sx * fz
    uz = sx * fy - sy * fx
    const bx = tx - fx * head
    const by = ty - fy * head
    const bz = tz - fz * head
    const w = head * 0.4
    list.line(tx, ty, tz, bx + sx * w, by + sy * w, bz + sz * w, c, meta)
    list.line(tx, ty, tz, bx - sx * w, by - sy * w, bz - sz * w, c, meta)
    list.line(tx, ty, tz, bx + ux * w, by + uy * w, bz + uz * w, c, meta)
    list.line(tx, ty, tz, bx - ux * w, by - uy * w, bz - uz * w, c, meta)
    this.expire(options, list, first)
  }

  /** A box: center, full size, rotation (quaternion, default none). */
  box(
    center: ArrayLike<number>,
    size: ArrayLike<number>,
    rotation: ArrayLike<number> | null,
    color: ArrayLike<number>,
    options?: GizmoOptions,
  ): void {
    const qx = rotation?.[0] ?? 0
    const qy = rotation?.[1] ?? 0
    const qz = rotation?.[2] ?? 0
    const qw = rotation?.[3] ?? 1
    // Rotation matrix columns.
    rot[0] = 1 - 2 * (qy * qy + qz * qz)
    rot[1] = 2 * (qx * qy + qz * qw)
    rot[2] = 2 * (qx * qz - qy * qw)
    rot[3] = 2 * (qx * qy - qz * qw)
    rot[4] = 1 - 2 * (qx * qx + qz * qz)
    rot[5] = 2 * (qy * qz + qx * qw)
    rot[6] = 2 * (qx * qz + qy * qw)
    rot[7] = 2 * (qy * qz - qx * qw)
    rot[8] = 1 - 2 * (qx * qx + qy * qy)
    for (let k = 0; k < 8; k++) {
      const x = (k & 1 ? 0.5 : -0.5) * size[0]!
      const y = (k & 2 ? 0.5 : -0.5) * size[1]!
      const z = (k & 4 ? 0.5 : -0.5) * size[2]!
      corners[k * 3] = center[0]! + rot[0] * x + rot[3] * y + rot[6] * z
      corners[k * 3 + 1] = center[1]! + rot[1] * x + rot[4] * y + rot[7] * z
      corners[k * 3 + 2] = center[2]! + rot[2] * x + rot[5] * y + rot[8] * z
    }
    this.edges(color, options)
  }

  /** A box from 8 corners in `corners` (bit 0: +x, bit 1: +y, bit 2: +z). */
  private edges(color: ArrayLike<number>, options: GizmoOptions | undefined): void {
    const list = this.list(options)
    const c = this.pack(color)
    const meta = this.meta(options, false)
    const first = list.lineCount
    for (let i = 0; i < 24; i += 2) {
      const a = BOX_EDGES[i]! * 3
      const b = BOX_EDGES[i + 1]! * 3
      list.line(
        corners[a]!,
        corners[a + 1]!,
        corners[a + 2]!,
        corners[b]!,
        corners[b + 1]!,
        corners[b + 2]!,
        c,
        meta,
      )
    }
    this.expire(options, list, first)
  }

  /**
   * The edges of a box given as a local AABB (`[minX, minY, minZ, maxX, maxY, maxZ]`) through an
   * affine transform (three rows of four, at `offset`): an oriented bounding box.
   */
  bounds(
    aabb: ArrayLike<number>,
    rows: ArrayLike<number>,
    offset: number,
    color: ArrayLike<number>,
    options?: GizmoOptions,
  ): void {
    for (let k = 0; k < 8; k++) {
      const x = k & 1 ? aabb[3]! : aabb[0]!
      const y = k & 2 ? aabb[4]! : aabb[1]!
      const z = k & 4 ? aabb[5]! : aabb[2]!
      for (let r = 0; r < 3; r++) {
        const o = offset + r * 4
        corners[k * 3 + r] = rows[o]! * x + rows[o + 1]! * y + rows[o + 2]! * z + rows[o + 3]!
      }
    }
    this.edges(color, options)
  }

  /** Three great circles. */
  sphere(
    center: ArrayLike<number>,
    radius: number,
    color: ArrayLike<number>,
    options?: GizmoOptions,
  ): void {
    this.circle(center, radius, 0, color, options)
    this.circle(center, radius, 1, color, options)
    this.circle(center, radius, 2, color, options)
  }

  /** A circle around axis 0 (x), 1 (y), or 2 (z). */
  circle(
    center: ArrayLike<number>,
    radius: number,
    axis: number,
    color: ArrayLike<number>,
    options?: GizmoOptions,
  ): void {
    const list = this.list(options)
    const c = this.pack(color)
    const meta = this.meta(options, false)
    const first = list.lineCount
    const cx = center[0]!
    const cy = center[1]!
    const cz = center[2]!
    let px = 0
    let py = 0
    let pz = 0
    for (let i = 0; i <= CIRCLE_SEGMENTS; i++) {
      const t = (i / CIRCLE_SEGMENTS) * Math.PI * 2
      const u = Math.cos(t) * radius
      const v = Math.sin(t) * radius
      const x = cx + (axis === 0 ? 0 : u)
      const y = cy + (axis === 0 ? u : axis === 1 ? 0 : v)
      const z = cz + (axis === 2 ? 0 : v)
      if (i > 0) list.line(px, py, pz, x, y, z, c, meta)
      px = x
      py = y
      pz = z
    }
    this.expire(options, list, first)
  }

  /**
   * A view frustum from its view-projection (reversed-Z). An infinite far plane draws at 20×
   * the near distance.
   */
  frustum(viewProj: ArrayLike<number>, color: ArrayLike<number>, options?: GizmoOptions): void {
    if (!mat4.invert(m4, viewProj)) return
    for (let k = 0; k < 8; k++) {
      const x = k & 1 ? 1 : -1
      const y = k & 2 ? 1 : -1
      let z = k & 4 ? 0 : 1
      let w = m4[3]! * x + m4[7]! * y + m4[11]! * z + m4[15]!
      if (z === 0 && Math.abs(w) < 1e-6) {
        z = 0.05
        w = m4[3]! * x + m4[7]! * y + m4[11]! * z + m4[15]!
      }
      for (let r = 0; r < 3; r++) {
        corners[k * 3 + r] = (m4[r]! * x + m4[4 + r]! * y + m4[8 + r]! * z + m4[12 + r]!) / w
      }
    }
    this.edges(color, options)
  }

  /** A square grid of `cells` × `cells` cells, `spacing` apart, facing `normal`. */
  grid(
    center: ArrayLike<number>,
    normal: ArrayLike<number>,
    cells: number,
    spacing: number,
    color: ArrayLike<number>,
    options?: GizmoOptions,
  ): void {
    const list = this.list(options)
    const c = this.pack(color)
    const meta = this.meta(options, false)
    const first = list.lineCount
    let nx = normal[0]!
    let ny = normal[1]!
    let nz = normal[2]!
    const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1
    nx /= nl
    ny /= nl
    nz /= nl
    // u = normalize(helper × n), v = n × u.
    const hx = Math.abs(ny) < 0.9 ? 0 : 1
    const hy = Math.abs(ny) < 0.9 ? 1 : 0
    let ux = hy * nz
    let uy = -hx * nz
    let uz = hx * ny - hy * nx
    const ul = Math.sqrt(ux * ux + uy * uy + uz * uz)
    ux /= ul
    uy /= ul
    uz /= ul
    const vx = ny * uz - nz * uy
    const vy = nz * ux - nx * uz
    const vz = nx * uy - ny * ux
    const half = (cells * spacing) / 2
    const cx = center[0]!
    const cy = center[1]!
    const cz = center[2]!
    for (let i = 0; i <= cells; i++) {
      const t = -half + i * spacing
      list.line(
        cx + ux * t - vx * half,
        cy + uy * t - vy * half,
        cz + uz * t - vz * half,
        cx + ux * t + vx * half,
        cy + uy * t + vy * half,
        cz + uz * t + vz * half,
        c,
        meta,
      )
      list.line(
        cx + vx * t - ux * half,
        cy + vy * t - uy * half,
        cz + vz * t - uz * half,
        cx + vx * t + ux * half,
        cy + vy * t + uy * half,
        cz + vz * t + uz * half,
        c,
        meta,
      )
    }
    this.expire(options, list, first)
  }

  /** Text just above a world position, facing the screen at a fixed pixel size, on a dark backing. */
  label(
    position: ArrayLike<number>,
    text: string,
    color: ArrayLike<number>,
    options?: GizmoOptions,
  ): void {
    const until = options?.duration ? this.now + options.duration : Number.POSITIVE_INFINITY
    this.list(options).label(
      position[0]!,
      position[1]!,
      position[2]!,
      text,
      this.pack(color),
      this.meta(options, true),
      until,
    )
  }

  /**
   * The floating origin moved (spec 0040): retained (timed) drawings, and this frame's drawings made
   * before the shift, move by `offset` so they stay put in the world. Overlays redraw each render.
   */
  shiftOrigin(x: number, y: number, z: number): void {
    this.timed.shift(x, y, z)
    this.frame.shift(x, y, z)
  }

  /** Lines and labels this frame, including timed ones still showing. */
  get lineCount(): number {
    return this.frame.lineCount + this.overlay.lineCount + this.timed.lineCount
  }

  get labelCount(): number {
    return this.frame.labelCount + this.overlay.labelCount + this.timed.labelCount
  }

  /** What's drawn, as data (`debug.gizmos`): up to `limit` lines, and every label. */
  describe(limit = 1000) {
    const lines: {
      from: number[]
      to: number[]
      color: number[]
      depthTest: boolean
      width: number
    }[] = []
    const labels: { position: number[]; text: string; color: number[]; depthTest: boolean }[] = []
    for (const list of [this.frame, this.overlay, this.timed]) {
      for (let i = 0; i < list.lineCount && lines.length < limit; i++) {
        const o = i * GIZMO_LINE_FLOATS
        const f = list.lines
        const meta = list.lineBits[o + 7]!
        lines.push({
          from: [f[o]!, f[o + 1]!, f[o + 2]!],
          to: [f[o + 3]!, f[o + 4]!, f[o + 5]!],
          color: unpackColor(list.lineBits[o + 6]!),
          depthTest: (meta & NO_DEPTH) === 0,
          width: (meta >>> 8) / 8,
        })
      }
      for (let i = 0; i < list.labelCount; i++) {
        labels.push({
          position: [list.labelPos[i * 3]!, list.labelPos[i * 3 + 1]!, list.labelPos[i * 3 + 2]!],
          text: list.labelText[i]!,
          color: unpackColor(list.labelColor[i]!),
          depthTest: (list.labelMeta[i]! & NO_DEPTH) === 0,
        })
      }
    }
    return { lineCount: this.lineCount, labelCount: this.labelCount, lines, labels }
  }
}

export const Gizmos = defineResource<GizmoStore>('render/Gizmos', {
  description:
    'Immediate-mode debug drawing: lines, shapes, and labels for this frame or a duration.',
  init: () => new GizmoStore(),
})

/** Clears last frame's gizmos and drops expired timed ones (First). */
export const beginGizmos = defineSystem({
  name: 'render/gizmos-begin',
  run: (_, world) => {
    const g = world.resource(Gizmos)
    g.now = world.resource(Time).elapsed
    g.frame.clear()
    g.timed.expire(g.now)
  },
})

// --- GPU -----------------------------------------------------------------------------------------

interface GizmoGpu {
  generation: number
  lines: DataStore
  glyphs: DataStore
  atlas: GPUTexture
  layouts: { view: GPUBindGroupLayout; data: GPUBindGroupLayout }
  pipelines: Map<string, GPURenderPipeline>
  groups: Map<string, { key: string; group: GPUBindGroup }>
  glyphData: Float32Array
  glyphBits: Uint32Array
  glyphCount: number
}

export const GizmoGpuResource = defineResource<{ gpu: GizmoGpu | undefined }>('render/GizmoGpu', {
  description: 'GPU buffers of the gizmo pass.',
  init: () => ({ gpu: undefined }),
})

function gizmoGpu(world: World, gpu: GpuContext): GizmoGpu {
  const r = world.initResource(GizmoGpuResource)
  if (r.gpu && r.gpu.generation === gpu.generation) return r.gpu
  const V = GPUShaderStage.VERTEX
  const F = GPUShaderStage.FRAGMENT
  const atlas = gpu.device.createTexture({
    label: 'gizmos/label-font',
    size: [LABEL_FONT.width, LABEL_FONT.height],
    format: 'r8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  })
  gpu.device.queue.writeTexture(
    { texture: atlas },
    labelAtlas() as Uint8Array<ArrayBuffer>,
    { bytesPerRow: LABEL_FONT.width },
    [LABEL_FONT.width, LABEL_FONT.height],
  )
  const glyphData = new Float32Array(GLYPH_FLOATS * 256)
  r.gpu = {
    generation: gpu.generation,
    // Read by the vertex stage: data textures on baseline (0064).
    lines: new DataStore(gpu, { label: 'gizmos/lines', size: 4096 }),
    glyphs: new DataStore(gpu, { label: 'gizmos/glyphs', size: 4096 }),
    atlas,
    layouts: {
      view: gpu.layouts.bindGroupLayout({
        label: 'gizmos/view',
        entries: [{ binding: 0, visibility: V | F, buffer: { type: 'uniform' } }],
      }),
      data: gpu.layouts.bindGroupLayout({
        label: 'gizmos/data',
        entries: [
          dataEntry(gpu, 0, V),
          dataEntry(gpu, 1, V),
          depthReadEntry(gpu, 2, F),
          { binding: 3, visibility: F, texture: { sampleType: 'float' } },
        ],
      }),
    },
    pipelines: new Map(),
    groups: new Map(),
    glyphData,
    glyphBits: new Uint32Array(glyphData.buffer),
    glyphCount: 0,
  }
  return r.gpu
}

function pushGlyph(
  g: GizmoGpu,
  x: number,
  y: number,
  z: number,
  ox: number,
  oy: number,
  w: number,
  h: number,
  glyph: number,
  color: number,
  meta: number,
): void {
  if ((g.glyphCount + 1) * GLYPH_FLOATS > g.glyphData.length) {
    const grown = new Float32Array(g.glyphData.length * 2)
    grown.set(g.glyphData)
    g.glyphData = grown
    g.glyphBits = new Uint32Array(grown.buffer)
  }
  const o = g.glyphCount++ * GLYPH_FLOATS
  const f = g.glyphData
  f[o] = x
  f[o + 1] = y
  f[o + 2] = z
  f[o + 3] = ox
  f[o + 4] = oy
  f[o + 6] = w
  f[o + 7] = h
  g.glyphBits[o + 8] = glyph
  g.glyphBits[o + 9] = color
  g.glyphBits[o + 10] = meta
}

const LABEL_BACKING = packGizmoColor([0, 0, 0, 0.65])
const PAD_X = 3

/** Label text into glyph quads: a backing box, then one quad per visible character. */
function layoutLabels(g: GizmoGpu, list: GizmoList): void {
  for (let i = 0; i < list.labelCount; i++) {
    const text = list.labelText[i]!
    const x = list.labelPos[i * 3]!
    const y = list.labelPos[i * 3 + 1]!
    const z = list.labelPos[i * 3 + 2]!
    const meta = list.labelMeta[i]!
    const color = list.labelColor[i]!
    const width = Math.ceil(labelWidth(text))
    const left = -Math.round(width / 2) - PAD_X
    // The box sits just above the anchor, so a label at an object's top doesn't cover it.
    const top = -LABEL_FONT.cellHeight - 4
    pushGlyph(
      g,
      x,
      y,
      z,
      left,
      top,
      width + PAD_X * 2,
      LABEL_FONT.cellHeight + 2,
      SOLID,
      LABEL_BACKING,
      meta,
    )
    let pen = left + PAD_X
    for (let k = 0; k < text.length; k++) {
      const code = text.charCodeAt(k)
      const index = code >= 32 && code < 127 ? code - 32 : 31
      if (index !== 0) {
        pushGlyph(
          g,
          x,
          y,
          z,
          Math.round(pen),
          top + 1,
          LABEL_FONT.cellWidth,
          LABEL_FONT.cellHeight,
          index,
          color,
          meta,
        )
      }
      pen += LABEL_FONT.advances[index]!
    }
  }
}

/** Uploads this frame's lines and label glyphs (Last, after overlays draw). */
export const uploadGizmos = defineSystem({
  name: 'render/gizmos-upload',
  run: (_, world) => {
    const gpu = world.tryResource(Gpu)
    if (!gpu) return
    const store = world.resource(Gizmos)
    const g = gizmoGpu(world, gpu)
    const bytes = GIZMO_LINE_FLOATS * 4
    g.lines.ensureCapacity(store.lineCount * bytes)
    let offset = 0
    for (const list of store.lists) {
      if (list.lineCount === 0) continue
      g.lines.write(list.lines, offset, 0, list.lineCount * GIZMO_LINE_FLOATS)
      offset += list.lineCount * bytes
    }
    g.glyphCount = 0
    for (const list of store.lists) layoutLabels(g, list)
    if (g.glyphCount > 0) g.glyphs.write(g.glyphData, 0, 0, g.glyphCount * GLYPH_FLOATS)
  },
})

const PREMULTIPLIED: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
}

function pipeline(
  ctx: NodeContext,
  g: GizmoGpu,
  kind: 'lines' | 'labels',
): GPURenderPipeline | undefined {
  const cached = g.pipelines.get(kind)
  if (cached) return cached
  const gpu = ctx.gpu
  const module = ctx.world.resource(Shaders).module(gpu, { root: `shard::gizmos::${kind}` })
  if (!module) {
    gpu.pipelines.skipped++
    return undefined
  }
  const p = gpu.pipelines.render({
    label: `gizmos/${kind}`,
    layout: gpu.layouts.pipelineLayout({
      label: 'gizmos',
      bindGroupLayouts: [g.layouts.view, g.layouts.data],
    }),
    vertex: { module, entryPoint: 'vs' },
    fragment: {
      module,
      entryPoint: 'fs',
      targets: [{ format: 'rgba16float', blend: PREMULTIPLIED }],
    },
    primitive: { topology: 'triangle-list' },
  })
  if (p) g.pipelines.set(kind, p)
  return p
}

const ids = new WeakMap<object, number>()
let nextId = 1
function idOf(o: object): number {
  let id = ids.get(o)
  if (id === undefined) {
    id = nextId++
    ids.set(o, id)
  }
  return id
}

function group(
  gpu: GpuContext,
  g: GizmoGpu,
  slot: string,
  key: string,
  layout: GPUBindGroupLayout,
  entries: () => GPUBindGroupEntry[],
): GPUBindGroup {
  let entry = g.groups.get(slot)
  if (!entry || entry.key !== key) {
    entry = { key, group: gpu.device.createBindGroup({ label: slot, layout, entries: entries() }) }
    g.groups.set(slot, entry)
  }
  return entry.group
}

/**
 * Gizmo lines, then labels, over the resolved HDR image: after transparent geometry, particles,
 * and the resolve, before post-processing and the tonemap.
 */
export function gizmoNode(world: World): NodeDescriptor {
  const store = world.resource(Gizmos)
  return {
    kind: 'render',
    phase: RenderPhase.Resolve + 30,
    enabled: (view: RenderView) =>
      cameraOf(view) !== undefined && store.lineCount + store.labelCount > 0,
    reads: ['depth'],
    writes: ['hdr'],
    color: [{ resource: 'hdr' }],
    run: (ctx) => {
      const lines = store.lineCount
      const r = ctx.world.resource(GizmoGpuResource).gpu
      const pv = ctx.world.resource(ForwardStateResource).views.get(ctx.view.name)
      if (!r || !pv || (lines === 0 && r.glyphCount === 0)) return
      const gpu = ctx.gpu
      const pass = ctx.renderPass!
      const depth = ctx.texture('depth')
      pass.setBindGroup(
        0,
        group(gpu, r, `view/${ctx.view.name}`, `${idOf(pv.uniform.buffer)}`, r.layouts.view, () => [
          { binding: 0, resource: { buffer: pv.uniform.buffer } },
        ]),
      )
      pass.setBindGroup(
        1,
        group(
          gpu,
          r,
          `data/${ctx.view.name}`,
          `${r.lines.version}/${r.glyphs.version}/${idOf(depth)}/${idOf(r.atlas)}`,
          r.layouts.data,
          () => [
            { binding: 0, resource: r.lines.resource() },
            { binding: 1, resource: r.glyphs.resource() },
            { binding: 2, resource: depth.createView() },
            { binding: 3, resource: r.atlas.createView() },
          ],
        ),
      )
      if (lines > 0) {
        const p = pipeline(ctx, r, 'lines')
        if (p) {
          pass.setPipeline(p)
          pass.draw(6, lines)
        }
      }
      if (r.glyphCount > 0) {
        const p = pipeline(ctx, r, 'labels')
        if (p) {
          pass.setPipeline(p)
          pass.draw(6, r.glyphCount)
        }
      }
    },
  }
}
