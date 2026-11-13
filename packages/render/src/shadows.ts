import { defineResource, frustum, mat4, type World } from '@aethervtt/shard-core'
import { GpuBuffer, type GpuContext } from '@aethervtt/shard-gpu'
import { Culler } from './culling'
import type { FoliageSupport } from './foliage-path'
import { GpuAssetsResource } from './gpu-assets'
import type { NodeContext } from './graph'
import {
  CasterClass,
  createDrawList,
  type DrawList,
  InstanceFlags,
  type InstanceStore,
  Instances,
  sphereInFrustum,
} from './instances'
import { type LightRecord, type LightStore, type ShadowSun, setShadowIndex } from './lights'
import {
  type MaterialPipelines,
  materialVariant,
  typeOrdinal,
  variantBlend,
  variantCull,
} from './material-pipelines'
import {
  cascadeSplits,
  createCascadeGeometry,
  fitCascadeGeometry,
  sliceSphereInto,
} from './shadow-volume'
import { bindingDimension } from './tier'
import type { CameraData } from './view'

export const MAX_CASCADES = 4
export const MAX_SHADOWED_SPOTS = 8
export const MAX_SHADOWED_POINTS = 4

/** Floats in a view's ShadowData buffer (see `shard::pbr::shadows`). */
export const SHADOW_DATA_FLOATS = 652
const OFF = {
  cascadeViewProj: 0,
  cascadeSplits: 64,
  cascadeTexel: 68,
  cascadeParams: 72,
  cascadeLight: 76,
  spotViewProj: 80,
  pointPosition: 208,
  pointViewProj: 224,
  sizes: 608,
  spotParams: 612,
  cascadeDynamic: 644,
  localDynamic: 648,
} as const

/** Point shadow faces cover a little more than 90° so PCF taps near an edge stay on the face. */
export function pointTanHalf(size: number): number {
  return 1 + 3 / size
}

/** Uniform stride for a shadow view's matrix (dynamic offsets need 256-byte alignment). */
const VIEW_STRIDE = 256

export interface ShadowViewDraw {
  viewProj: Float32Array
  frustum: Float32Array
  /** What casters are culled against: the frustum, but open toward the light for cascades. */
  cullPlanes: Float32Array
  draws: DrawList
  /** Dynamic offset of this view's matrix in the frame's shadow uniforms. */
  offset: number
  /** Whether its layer holds a complete draw (0055: cached shadows keep it). */
  drawn: boolean
  /** The matrix and `InstanceStore.shadowEpoch` it was drawn with. */
  drawnViewProj: Float32Array
  drawnEpoch: number
  /** Set by the queue: draw it this frame. */
  redraw: boolean
  /** The texture array layer it draws into. */
  layer: number
  /**
   * Which casters it draws (0116): all, the static ones (a cached layer), or the dynamic ones (the
   * layer drawn over it each frame). See `CasterClass`.
   */
  classes: number
  /** Shadow volume test (CullParams.sweepMode): 0 none, 1 along a sun, 2 away from a local light. */
  sweepMode: number
  sweep: Float32Array
  margin: number
  minRadius: number
  /** Redraw only the texels in `rect` (x0, y0, x1, y1), clearing them first (0116). */
  rect: boolean
  readonly rects: Float32Array
}

export function shadowView(layer = 0): ShadowViewDraw {
  return {
    viewProj: mat4.create(),
    frustum: frustum.create(),
    cullPlanes: frustum.create(),
    draws: createDrawList(),
    offset: 0,
    drawn: false,
    drawnViewProj: mat4.create(),
    drawnEpoch: -1,
    redraw: true,
    layer,
    classes: CasterClass.all,
    sweepMode: 0,
    sweep: new Float32Array(4),
    margin: 0,
    minRadius: 0,
    rect: false,
    rects: new Float32Array(4),
  }
}

/**
 * Whether a shadow view of a local light must draw this frame. Views of `shadowUpdate: 'always'`
 * lights always do. A cached static view draws when its layer isn't complete, its matrix changed,
 * what casts shadows changed (`shadowEpoch`), or a static caster changed inside its frustum (0116).
 */
export function shadowRedraw(view: ShadowViewDraw, cached: boolean, store: InstanceStore): boolean {
  if (!cached || !view.drawn || view.drawnEpoch !== store.shadowEpoch) return true
  const a = view.viewProj
  const b = view.drawnViewProj
  for (let i = 0; i < 16; i++) if (a[i] !== b[i]) return true
  return staticChangeIn(store, view.cullPlanes)
}

/** Whether any of this frame's static changes touch the half-spaces `planes`. */
function staticChangeIn(store: InstanceStore, planes: Float32Array): boolean {
  const c = store.staticChanges
  const sphere = scratchSphere
  for (let k = 0; k < store.staticChangeCount; k++) {
    sphere[0] = c[k * 4]!
    sphere[1] = c[k * 4 + 1]!
    sphere[2] = c[k * 4 + 2]!
    sphere[3] = c[k * 4 + 3]!
    if (sphereInFrustum(planes, sphere)) return true
  }
  return false
}

/** Records that a shadow view's layer now holds a complete draw of this frame's state. */
export function markShadowDrawn(view: ShadowViewDraw, store: InstanceStore): void {
  view.drawn = true
  view.drawnViewProj.set(view.viewProj)
  view.drawnEpoch = store.shadowEpoch
}

/**
 * A camera's cascades: fitted each frame, one depth layer each. Cached cascades (0116) have two:
 * `views` holds static casters at layers 0–3 and redraws only where they changed, and `dynamic`
 * draws the rest over it each frame at layers 4–7. Receivers sample both.
 */
export class Cascades {
  count = 0
  readonly geometry = createCascadeGeometry()
  readonly views: ShadowViewDraw[] = [shadowView(0), shadowView(1), shadowView(2), shadowView(3)]
  readonly dynamic: ShadowViewDraw[] = [shadowView(4), shadowView(5), shadowView(6), shadowView(7)]
  readonly splits = this.geometry.splits
  readonly texel = this.geometry.texel
  /** Light-space centers after snapping (for tests: sub-texel moves don't change them). */
  readonly centers = this.geometry.centers
  /** Whether each cascade's dynamic layer holds casters (receivers sample it). */
  readonly dynamicOn = new Uint8Array(4)
  /** Cached: static and dynamic layers. */
  cached = false
  /** The box each static layer was drawn with: light-space center, radius, near depth. */
  readonly drawnFit = new Float32Array(4 * 8)
  /** A full static redraw waits for a frame of its own (one per light per frame). */
  readonly pendingFull = new Uint8Array(4)
  /** Static redraws this frame, full and rect, and which cascades (bit masks; describe, tests). */
  fullRedraws = 0
  rectRedraws = 0
  fullMask = 0
  rectMask = 0
  texture: GPUTexture | undefined
  size = 0
  layers = 0
  generation = -1

  ensureTexture(gpu: GpuContext, size: number, label: string): GPUTexture {
    const layers = this.cached ? MAX_CASCADES * 2 : MAX_CASCADES
    if (
      !this.texture ||
      this.size !== size ||
      this.layers !== layers ||
      this.generation !== gpu.generation
    ) {
      this.texture?.destroy()
      for (const view of this.views) view.drawn = false
      for (const view of this.dynamic) view.drawn = false
      this.texture = gpu.device.createTexture({
        label: `${label}/cascades`,
        size: [size, size, layers],
        format: 'depth32float',
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_SRC,
        ...bindingDimension(gpu, '2d-array'),
      })
      this.size = size
      this.layers = layers
      this.generation = gpu.generation
    }
    return this.texture
  }
}

const scratchPlanes = new Float32Array(24)
const scratchBox = new Float32Array(6)
const dynamicBox = new Float32Array(6)
const scratchSphere = new Float32Array(4)
const scratchLightView = mat4.create()
const scratchLightProj = mat4.create()

/** Practical split scheme (see shadow-volume.ts). */
export { cascadeSplits }

/** The bounding sphere of a view-frustum slice [a, b]: its center's view depth, and its radius. */
export function sliceSphere(cam: CameraData, a: number, b: number): [number, number] {
  const out: [number, number] = [0, 0]
  sliceSphereInto(out, cam, a, b)
  return out
}

/** Culls a shadow view's casters into its draw list, unioning their bounds into `box`. */
export type CullShadow = (
  view: ShadowViewDraw,
  planes: Float32Array,
  box: Float32Array | undefined,
) => boolean

/** The light-space depth nearest the light among `box`'s corners. */
function nearestDepth(basis: Float32Array, box: Float32Array, start: number): number {
  let z = start
  for (let c = 0; c < 8; c++) {
    const x = c & 1 ? box[3]! : box[0]!
    const y = c & 2 ? box[4]! : box[1]!
    const w = c & 4 ? box[5]! : box[2]!
    const d = basis[6]! * x + basis[7]! * y + basis[8]! * w
    if (d < z) z = d
  }
  return z
}

/** Box planes: four sides around (lx, ly) of half-sizes (hx, hy), and the far side lz. */
function boxPlanes(
  p: Float32Array,
  basis: Float32Array,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  far: number,
): void {
  setPlane(p, 0, basis[0]!, basis[1]!, basis[2]!, -x0)
  setPlane(p, 1, -basis[0]!, -basis[1]!, -basis[2]!, x1)
  setPlane(p, 2, basis[3]!, basis[4]!, basis[5]!, -y0)
  setPlane(p, 3, -basis[3]!, -basis[4]!, -basis[5]!, y1)
  setPlane(p, 4, -basis[6]!, -basis[7]!, -basis[8]!, far)
  setPlane(p, 5, 0, 0, 0, 1)
}

function setPlane(p: Float32Array, k: number, nx: number, ny: number, nz: number, d: number) {
  p[k * 4] = nx
  p[k * 4 + 1] = ny
  p[k * 4 + 2] = nz
  p[k * 4 + 3] = d
}

/**
 * Fits and culls a camera's cascades for the shadowed sun (0018, 0116). Each cascade is the slice's
 * bounding sphere in light space, snapped (to texels, or for cached cascades to steps).
 *
 * An `'always'` sun has one layer per cascade, holding every caster whose shadow can land in the
 * slice. A cached sun has a static layer, culled against the cascade's box and redrawn only when
 * the box moved, the light turned, or a static caster changed (then only that rectangle), and a
 * dynamic layer of dynamic casters whose shadows reach the slice, redrawn each frame (far cascades
 * less often). At most one full static redraw per frame: others wait with their old matrices.
 */
export function fitCascades(
  cascades: Cascades,
  cam: CameraData,
  sun: ShadowSun,
  size: number,
  store: InstanceStore,
  frame: number,
  animatedNear: boolean,
  cull: CullShadow,
): void {
  const geo = cascades.geometry
  fitCascadeGeometry(geo, cam, sun, size)
  const count = geo.count
  cascades.count = count
  const cached = sun.cached
  if (cached !== cascades.cached) {
    cascades.cached = cached
    cascades.pendingFull.fill(0)
    for (const view of cascades.views) view.drawn = false
  }
  cascades.fullRedraws = 0
  cascades.rectRedraws = 0
  cascades.fullMask = 0
  cascades.rectMask = 0
  const basis = geo.basis
  const anyDynamic = store.dynamicCasters > 0
  let fullBudget = 1
  for (let i = 0; i < count; i++) {
    const lx = geo.centers[i * 3]!
    const ly = geo.centers[i * 3 + 1]!
    const lz = geo.centers[i * 3 + 2]!
    const radius = geo.radius[i]!
    const texel = geo.texel[i]!
    const sv = cascades.views[i]!
    const dv = cascades.dynamic[i]!
    // Box planes: four sides and the far side; nothing between the light and the cascade is culled.
    boxPlanes(scratchPlanes, basis, lx - radius, lx + radius, ly - radius, ly + radius, lz + radius)
    sv.cullPlanes.set(scratchPlanes)
    const slice = geo.slices.subarray(i * 24, i * 24 + 24)
    const margin = texel * (2 + sun.softness + sun.normalBias)
    const minRadius = sun.minCasterTexels * texel * 0.5
    sv.rect = false
    if (!cached) {
      // One layer: every caster whose shadow can land in the slice.
      sv.classes = CasterClass.all
      setSweep(sv, basis, lz + radius, margin, minRadius)
      const any = cull(sv, slice, scratchBox)
      const zNear = any ? nearestDepth(basis, scratchBox, lz - radius) : lz - radius
      writeMatrix(sv, basis, lx, ly, lz, radius, quantize(zNear, radius))
      sv.redraw = true
      cascades.dynamicOn[i] = 0
      dv.redraw = false
      continue
    }
    // Cached: the static layer (box planes, static casters) and the dynamic layer over it.
    const fit = cascades.drawnFit
    const f = i * 8
    let full =
      !sv.drawn ||
      cascades.pendingFull[i] === 1 ||
      sv.drawnEpoch !== store.shadowEpoch ||
      fit[f] !== Math.fround(lx) ||
      fit[f + 1] !== Math.fround(ly) ||
      fit[f + 2] !== Math.fround(lz) ||
      fit[f + 3] !== Math.fround(radius) ||
      fit[f + 5] !== Math.fround(basis[6]!) ||
      fit[f + 6] !== Math.fround(basis[7]!) ||
      fit[f + 7] !== Math.fround(basis[8]!)
    let zNear = fit[f + 4]!
    sv.classes = CasterClass.static
    sv.sweepMode = 0
    sv.margin = 0
    sv.minRadius = minRadius
    // Dynamic casters: every frame near, every few frames far (staggered), and whenever the static
    // layer moves under them.
    const every = Math.max(1, sun.farEvery >> (count - 1 - i))
    const due = every <= 1 || (frame + i) % every === 0
    dv.classes = CasterClass.dynamic
    setSweep(dv, basis, lz + radius, margin, minRadius)
    const foliageHere = animatedNear && i === 0
    const dynamicNow =
      (foliageHere ||
        (anyDynamic && store.anyDynamicIn(slice, 1, dv.sweep, dv.margin, dv.minRadius))) &&
      (due || full || !dv.drawn)
    let dynamicTop = Number.POSITIVE_INFINITY
    let dynamicAny = false
    if (dynamicNow) {
      dynamicAny = cull(dv, slice, dynamicBox)
      if (dynamicAny) dynamicTop = nearestDepth(basis, dynamicBox, Number.POSITIVE_INFINITY)
    }
    // A dynamic caster nearer the light than the drawn range grows it: a full redraw.
    if (!full && dynamicTop < zNear) full = true
    // Otherwise only the rectangle this frame's static changes touch, unless that's most of it.
    let rect = false
    if (!full) {
      const r = staticRect(sv, store, basis, lx, ly, lz, radius, size)
      if (r === 2) full = true
      rect = r === 1
    }
    // A full redraw waits for its own frame unless the layer is empty; the old one stays valid
    // inside its step's guard band.
    if (full && sv.drawn && fullBudget === 0) {
      cascades.pendingFull[i] = 1
      sv.redraw = false
      sv.viewProj.set(sv.drawnViewProj)
    } else {
      if (full) {
        fullBudget--
        cascades.pendingFull[i] = 0
        sv.cullPlanes.set(scratchPlanes)
        const any = cull(sv, scratchPlanes, scratchBox)
        let z = any ? nearestDepth(basis, scratchBox, lz - radius) : lz - radius
        if (dynamicTop < z) z = dynamicTop
        zNear = quantize(z, radius)
        writeMatrix(sv, basis, lx, ly, lz, radius, zNear)
        fit[f] = lx
        fit[f + 1] = ly
        fit[f + 2] = lz
        fit[f + 3] = radius
        fit[f + 4] = zNear
        fit[f + 5] = basis[6]!
        fit[f + 6] = basis[7]!
        fit[f + 7] = basis[8]!
        sv.redraw = true
        cascades.fullRedraws++
        cascades.fullMask |= 1 << i
      } else {
        sv.redraw = rect
        sv.rect = rect
        if (rect) {
          cull(sv, sv.cullPlanes, undefined)
          cascades.rectRedraws++
          cascades.rectMask |= 1 << i
        }
      }
    }
    dv.viewProj.set(sv.viewProj)
    dv.redraw = dynamicNow
    // Sampled while it holds casters. A far cascade waiting its turn keeps what it drew; one that
    // was due with nothing casting into it stops being sampled.
    if (dynamicNow) cascades.dynamicOn[i] = dynamicAny || foliageHere ? 1 : 0
    else if (due || full || !dv.drawn) cascades.dynamicOn[i] = 0
  }
}

function setSweep(
  view: ShadowViewDraw,
  basis: Float32Array,
  far: number,
  margin: number,
  minRadius: number,
): void {
  view.sweepMode = 1
  view.sweep[0] = basis[6]!
  view.sweep[1] = basis[7]!
  view.sweep[2] = basis[8]!
  view.sweep[3] = far
  view.margin = margin
  view.minRadius = minRadius
}

/** Depth ranges step in quarters of the cascade's radius, so they don't change as casters move. */
function quantize(zNear: number, radius: number): number {
  const q = radius * 0.25
  return Math.floor((zNear - q * 0.5) / q) * q
}

function writeMatrix(
  view: ShadowViewDraw,
  basis: Float32Array,
  lx: number,
  ly: number,
  lz: number,
  radius: number,
  zNear: number,
): void {
  // View: rotation into light space (camera looks down -Z, so z row = -forward).
  const v = mat4.identity(scratchLightView)
  v[0] = basis[0]!
  v[4] = basis[1]!
  v[8] = basis[2]!
  v[1] = basis[3]!
  v[5] = basis[4]!
  v[9] = basis[5]!
  v[2] = -basis[6]!
  v[6] = -basis[7]!
  v[10] = -basis[8]!
  const proj = mat4.orthographicReversedZ(
    scratchLightProj,
    lx - radius,
    lx + radius,
    ly - radius,
    ly + radius,
    zNear,
    lz + radius,
  )
  mat4.multiply(view.viewProj, proj, v)
  frustum.fromViewProjection(view.frustum, view.viewProj)
}

/**
 * The rectangle of a cached static layer this frame's static changes touch, in texels, into
 * `view.rects`, with its cull planes narrowed to it: 1. 0 if none touch the cascade; 2 if the
 * rectangle is over half the layer (a full redraw instead).
 */
function staticRect(
  view: ShadowViewDraw,
  store: InstanceStore,
  basis: Float32Array,
  lx: number,
  ly: number,
  lz: number,
  radius: number,
  size: number,
): number {
  const c = store.staticChanges
  let x0 = Number.POSITIVE_INFINITY
  let y0 = Number.POSITIVE_INFINITY
  let x1 = Number.NEGATIVE_INFINITY
  let y1 = Number.NEGATIVE_INFINITY
  for (let k = 0; k < store.staticChangeCount; k++) {
    const cx = c[k * 4]!
    const cy = c[k * 4 + 1]!
    const cz = c[k * 4 + 2]!
    const r = c[k * 4 + 3]!
    const x = basis[0]! * cx + basis[1]! * cy + basis[2]! * cz
    const y = basis[3]! * cx + basis[4]! * cy + basis[5]! * cz
    const z = basis[6]! * cx + basis[7]! * cy + basis[8]! * cz
    // Outside the box, or wholly past its far side: not in this layer.
    if (x + r < lx - radius || x - r > lx + radius) continue
    if (y + r < ly - radius || y - r > ly + radius) continue
    if (z - r > lz + radius) continue
    if (x - r < x0) x0 = x - r
    if (x + r > x1) x1 = x + r
    if (y - r < y0) y0 = y - r
    if (y + r > y1) y1 = y + r
  }
  if (x1 < x0) return 0
  // To texels, a texel wider each way (rasterization rounds), clamped to the layer.
  const scale = size / (2 * radius)
  const tx0 = Math.max(0, Math.floor((x0 - (lx - radius)) * scale) - 1)
  const tx1 = Math.min(size, Math.ceil((x1 - (lx - radius)) * scale) + 1)
  // Texel rows run top down: light-space y up.
  const ty0 = Math.max(0, Math.floor((ly + radius - y1) * scale) - 1)
  const ty1 = Math.min(size, Math.ceil((ly + radius - y0) * scale) + 1)
  if (tx1 <= tx0 || ty1 <= ty0) return 0
  if ((tx1 - tx0) * (ty1 - ty0) > size * size * 0.5) return 2
  view.rects[0] = tx0
  view.rects[1] = ty0
  view.rects[2] = tx1
  view.rects[3] = ty1
  // The planes of the rectangle: only casters over it draw.
  const lo = lx - radius
  const top = ly + radius
  boxPlanes(
    view.cullPlanes,
    basis,
    lo + tx0 / scale,
    lo + tx1 / scale,
    top - ty1 / scale,
    top - ty0 / scale,
    lz + radius,
  )
  return 1
}

/** Spot and point shadows: shared by every camera, rendered once per frame. */
export class LocalShadows {
  readonly spots: (LightRecord | undefined)[] = []
  readonly points: (LightRecord | undefined)[] = []
  readonly spotViews: ShadowViewDraw[] = []
  readonly pointViews: ShadowViewDraw[] = []
  /**
   * Dynamic layers of cached lights (0116), drawn over their static views each frame, after the
   * static layers in the same arrays: spot i's at `spots.length + i`, point face k's at
   * `points.length * 6 + k`.
   */
  readonly spotDynamic: ShadowViewDraw[] = []
  readonly pointDynamic: ShadowViewDraw[] = []
  /** Which spots and point lights have a dynamic layer with casters this frame (bit masks). */
  spotDynamicOn = 0
  pointDynamicOn = 0
  /** Near plane and tan(half angle) per spot. */
  readonly spotParams = new Float32Array(MAX_SHADOWED_SPOTS * 4)
  /** Position and near plane per point light. */
  readonly pointPositions = new Float32Array(MAX_SHADOWED_POINTS * 4)
  /** Shadow-casting lights that didn't fit the budget this frame. */
  overBudget: LightRecord[] = []
  spotTexture: GPUTexture | undefined
  pointTexture: GPUTexture | undefined
  spotLayers = 0
  pointLayers = 0
  size = 0
  generation = -1
  /** The frame these were last rendered (they render once per frame, not per view). */
  renderedFrame = -1

  constructor() {
    for (let i = 0; i < MAX_SHADOWED_SPOTS; i++) {
      this.spotViews.push(shadowView(i))
      this.spotDynamic.push(shadowView())
    }
    for (let i = 0; i < MAX_SHADOWED_POINTS * 6; i++) {
      this.pointViews.push(shadowView(i))
      this.pointDynamic.push(shadowView())
    }
  }

  /** Whether any assigned light is cached (its arrays then hold dynamic layers too). */
  get anyCached(): boolean {
    for (const r of this.spots) if (r?.cachedShadow) return true
    for (const r of this.points) if (r?.cachedShadow) return true
    return false
  }

  ensureTextures(gpu: GpuContext, size: number): void {
    const twice = this.anyCached ? 2 : 1
    const spotLayers = Math.max(1, this.spots.length * twice)
    const pointLayers = Math.max(1, this.points.length * twice) * 6
    for (let i = 0; i < this.spotDynamic.length; i++)
      this.spotDynamic[i]!.layer = this.spots.length + i
    for (let i = 0; i < this.pointDynamic.length; i++)
      this.pointDynamic[i]!.layer = this.points.length * 6 + i
    const fresh = this.generation !== gpu.generation || this.size !== size
    const make = (label: string, layers: number) =>
      gpu.device.createTexture({
        label,
        size: [size, size, layers],
        format: 'depth32float',
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_SRC,
        ...bindingDimension(gpu, '2d-array'),
      })
    if (fresh || !this.spotTexture || spotLayers > this.spotLayers) {
      this.spotTexture?.destroy()
      for (const view of this.spotViews) view.drawn = false
      this.spotLayers = Math.max(spotLayers, fresh ? 1 : this.spotLayers)
      this.spotTexture = make('shadows/spots', this.spotLayers)
    }
    if (fresh || !this.pointTexture || pointLayers > this.pointLayers) {
      this.pointTexture?.destroy()
      for (const view of this.pointViews) view.drawn = false
      this.pointLayers = Math.max(pointLayers, fresh ? 6 : this.pointLayers)
      this.pointTexture = make('shadows/points', this.pointLayers)
    }
    this.size = size
    this.generation = gpu.generation
  }
}

/** Point shadow faces: +X, -X, +Y, -Y, +Z, -Z, each with an up vector. Mirrors the WGSL lookup. */
const FACES = [
  [1, 0, 0, 0, -1, 0],
  [-1, 0, 0, 0, -1, 0],
  [0, 1, 0, 0, 0, 1],
  [0, -1, 0, 0, 0, -1],
  [0, 0, 1, 0, -1, 0],
  [0, 0, -1, 0, -1, 0],
] as const

function lookDir(
  out: Float32Array,
  px: number,
  py: number,
  pz: number,
  dx: number,
  dy: number,
  dz: number,
  upx: number,
  upy: number,
  upz: number,
): Float32Array {
  return mat4.lookAt(out, [px, py, pz], [px + dx, py + dy, pz + dz], [upx, upy, upz])
}

const scratchView = mat4.create()
const scratchProj = mat4.create()

/**
 * Ranks shadow-casting spot and point lights by screen-space influence from `cam` and assigns
 * shadow maps within the budgets. Lights over budget render without shadows this frame.
 */
export function assignLocalShadows(
  shadows: LocalShadows,
  store: LightStore,
  cam: CameraData | undefined,
  maxSpots: number,
  maxPoints: number,
): void {
  const spots: { r: LightRecord; score: number }[] = []
  const points: { r: LightRecord; score: number }[] = []
  for (let s = 0; s < store.high; s++) {
    const r = store.records[s]
    if (!r?.alive) continue
    if (!r.shadows || !cam) {
      setShadowIndex(store, r, -1)
      continue
    }
    const dx = r.x - cam.position[0]!
    const dy = r.y - cam.position[1]!
    const dz = r.z - cam.position[2]!
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
    // Angular size of the light's sphere of influence; inside it, it's everything.
    let score = r.range / Math.max(d - r.range, 1e-3)
    // Off-screen lights still cast shadows on-screen, but rank below visible ones.
    let visible = true
    for (let p = 0; p < 24; p += 4) {
      const f = cam.frustum
      if (f[p]! * r.x + f[p + 1]! * r.y + f[p + 2]! * r.z + f[p + 3]! < -r.range) visible = false
    }
    if (!visible) score *= 1e-6
    ;(r.kind === 1 ? spots : points).push({ r, score })
  }
  const byScore = (a: { r: LightRecord; score: number }, b: { r: LightRecord; score: number }) =>
    b.score - a.score || b.r.intensity - a.r.intensity || a.r.slot - b.r.slot
  spots.sort(byScore)
  points.sort(byScore)
  const over: LightRecord[] = []
  shadows.spots.length = 0
  shadows.points.length = 0
  spots.forEach(({ r }, i) => {
    if (i < Math.min(maxSpots, MAX_SHADOWED_SPOTS)) {
      setShadowIndex(store, r, i)
      shadows.spots.push(r)
    } else {
      setShadowIndex(store, r, -1)
      over.push(r)
    }
  })
  points.forEach(({ r }, i) => {
    if (i < Math.min(maxPoints, MAX_SHADOWED_POINTS)) {
      setShadowIndex(store, r, i)
      shadows.points.push(r)
    } else {
      setShadowIndex(store, r, -1)
      over.push(r)
    }
  })
  shadows.overBudget = over
}

/** Builds the spot and point shadow view matrices for the assigned lights. */
export function fitLocalShadows(shadows: LocalShadows, size: number): void {
  for (let i = 0; i < shadows.spots.length; i++) {
    const r = shadows.spots[i]!
    const near = Math.max(0.05, r.radius)
    const tanHalf = Math.tan((Math.min(r.outerAngle, 89) * Math.PI) / 180) * (1 + 3 / size)
    const up = Math.abs(r.dy) > 0.99 ? [1, 0, 0] : [0, 1, 0]
    lookDir(scratchView, r.x, r.y, r.z, r.dx, r.dy, r.dz, up[0]!, up[1]!, up[2]!)
    mat4.perspectiveReversedZ(scratchProj, 2 * Math.atan(tanHalf), 1, near)
    const view = shadows.spotViews[i]!
    mat4.multiply(view.viewProj, scratchProj, scratchView)
    frustum.fromViewProjection(view.frustum, view.viewProj)
    view.cullPlanes.set(view.frustum)
    shadows.spotParams[i * 4] = tanHalf
    shadows.spotParams[i * 4 + 1] = near
  }
  const tanHalf = pointTanHalf(size)
  for (let i = 0; i < shadows.points.length; i++) {
    const r = shadows.points[i]!
    const near = Math.max(0.05, r.radius)
    shadows.pointPositions[i * 4] = r.x
    shadows.pointPositions[i * 4 + 1] = r.y
    shadows.pointPositions[i * 4 + 2] = r.z
    shadows.pointPositions[i * 4 + 3] = near
    mat4.perspectiveReversedZ(scratchProj, 2 * Math.atan(tanHalf), 1, near)
    for (let f = 0; f < 6; f++) {
      const face = FACES[f]!
      lookDir(scratchView, r.x, r.y, r.z, face[0], face[1], face[2], face[3], face[4], face[5])
      const view = shadows.pointViews[i * 6 + f]!
      mat4.multiply(view.viewProj, scratchProj, scratchView)
      frustum.fromViewProjection(view.frustum, view.viewProj)
      view.cullPlanes.set(view.frustum)
    }
  }
}

/** Packs a view's ShadowData: its cascades plus the shared spot and point shadows. */
export function packShadowData(
  out: Float32Array,
  cascades: Cascades | undefined,
  sun: { direction: Float32Array; bias: number; normalBias: number; softness: number } | null,
  local: LocalShadows,
  cascadeSize: number,
  size: number,
): void {
  out.fill(0)
  if (cascades && sun && cascades.count > 0) {
    for (let i = 0; i < cascades.count; i++) {
      out.set(cascades.views[i]!.viewProj, OFF.cascadeViewProj + i * 16)
      out[OFF.cascadeSplits + i] = cascades.splits[i]!
      out[OFF.cascadeTexel + i] = cascades.texel[i]!
    }
    out[OFF.cascadeParams] = cascades.count
    out[OFF.cascadeParams + 1] = sun.bias
    out[OFF.cascadeParams + 2] = sun.normalBias
    out[OFF.cascadeParams + 3] = sun.softness
    out[OFF.cascadeLight] = sun.direction[0]!
    out[OFF.cascadeLight + 1] = sun.direction[1]!
    out[OFF.cascadeLight + 2] = sun.direction[2]!
    out[OFF.cascadeLight + 3] = 1
  }
  for (let i = 0; i < local.spots.length; i++) {
    out.set(local.spotViews[i]!.viewProj, OFF.spotViewProj + i * 16)
    out[OFF.spotParams + i * 4] = local.spotParams[i * 4]!
    out[OFF.spotParams + i * 4 + 1] = local.spotParams[i * 4 + 1]!
  }
  for (let i = 0; i < local.points.length; i++) {
    for (let k = 0; k < 4; k++)
      out[OFF.pointPosition + i * 4 + k] = local.pointPositions[i * 4 + k]!
    for (let f = 0; f < 6; f++)
      out.set(local.pointViews[i * 6 + f]!.viewProj, OFF.pointViewProj + (i * 6 + f) * 16)
  }
  out[OFF.sizes] = cascadeSize
  out[OFF.sizes + 1] = size
  out[OFF.sizes + 2] = pointTanHalf(size)
  // Dynamic layers (0116): which ones receivers sample too, and where local ones start.
  if (cascades?.cached)
    for (let i = 0; i < cascades.count; i++) out[OFF.cascadeDynamic + i] = cascades.dynamicOn[i]!
  out[OFF.localDynamic] = local.spotDynamicOn
  out[OFF.localDynamic + 1] = local.pointDynamicOn
  out[OFF.localDynamic + 2] = local.spots.length
  out[OFF.localDynamic + 3] = local.points.length * 6
}

// --- GPU passes ----------------------------------------------------------------

/** Shadow view matrices for every shadow pass in the frame, at 256-byte offsets. */
export class ShadowPassUniforms {
  data = new Float32Array((VIEW_STRIDE / 4) * 64)
  count = 0
  readonly buffer: GpuBuffer
  bindGroup: GPUBindGroup | undefined
  private bound = ''
  private readonly gpu: GpuContext
  /** What the buffer holds, so unchanged shadow views write nothing (0055). */
  private sent = new Float32Array(0)
  private sentCount = 0
  private sentVersion = -1
  private sentGeneration = -1

  constructor(gpu: GpuContext) {
    this.gpu = gpu
    this.buffer = new GpuBuffer(gpu, {
      label: 'shadows/views',
      usage: GPUBufferUsage.UNIFORM,
      size: VIEW_STRIDE * 64,
    })
  }

  reset(): void {
    this.count = 0
  }

  /** Adds a view matrix; returns its dynamic offset. */
  push(viewProj: Float32Array): number {
    const floats = VIEW_STRIDE / 4
    if ((this.count + 1) * floats > this.data.length) {
      const grown = new Float32Array(this.data.length * 2)
      grown.set(this.data)
      this.data = grown
    }
    this.data.set(viewProj, this.count * floats)
    return this.count++ * VIEW_STRIDE
  }

  upload(layout: GPUBindGroupLayout, globals: GpuBuffer): void {
    const floats = (this.count * VIEW_STRIDE) / 4
    if (this.count > 0 && !this.unchanged(floats)) {
      this.buffer.write(this.data, 0, 0, floats)
      if (this.sent.length < this.data.length) this.sent = new Float32Array(this.data.length)
      this.sent.set(this.data.subarray(0, floats))
      this.sentCount = this.count
      this.sentVersion = this.buffer.version
      this.sentGeneration = this.gpu.generation
    }
    const key = `${this.buffer.version}/${globals.version}/${this.gpu.generation}`
    if (!this.bindGroup || this.bound !== key) {
      this.bindGroup = this.gpu.device.createBindGroup({
        label: 'shadows/views',
        layout,
        entries: [
          { binding: 0, resource: { buffer: this.buffer.buffer, size: 64 } },
          { binding: 14, resource: { buffer: globals.buffer } },
        ],
      })
      this.bound = key
    }
  }

  private unchanged(floats: number): boolean {
    if (this.sentCount < this.count) return false
    if (this.sentVersion !== this.buffer.version || this.sentGeneration !== this.gpu.generation)
      return false
    const data = this.data
    const sent = this.sent
    for (let i = 0; i < floats; i++) if (data[i] !== sent[i]) return false
    return true
  }
}

export function shadowViewLayout(gpu: GpuContext): GPUBindGroupLayout {
  return gpu.layouts.bindGroupLayout({
    label: 'shadows/view',
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: 'uniform', hasDynamicOffset: true },
      },
      {
        binding: 14,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      },
    ],
  })
}

const SHADOW_BUFFERS: GPUVertexBufferLayout[] = [
  { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
  { arrayStride: 12, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
  { arrayStride: 8, attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x2' }] },
  { arrayStride: 8, attributes: [{ shaderLocation: 3, offset: 0, format: 'float32x2' }] },
  { arrayStride: 16, attributes: [{ shaderLocation: 4, offset: 0, format: 'float32x4' }] },
]

/**
 * Draws a shadow view's casters into a depth layer, with each material type's vertex stage (so
 * `vertex_position` displacement moves shadows too). Opaque materials are vertex-only; masked
 * standard materials run the surface stage to discard.
 */
export function drawShadowCasters(
  ctx: NodeContext,
  target: GPUTextureView,
  view: ShadowViewDraw,
  offset: number,
  uniforms: ShadowPassUniforms,
  pipelines: MaterialPipelines,
  shadowView: GPUBindGroupLayout,
  label: string,
  foliage?: FoliageSupport,
  cam?: CameraData,
  cascade = 0,
  clearRect?: GPURenderPipeline,
): void {
  const world = ctx.world
  const gpu = ctx.gpu
  const store = world.resource(Instances)
  const assets = world.resource(GpuAssetsResource)
  // A rect redraw (0116) keeps the layer and redraws only its rectangle: cleared to the far depth
  // (0 in reversed Z, what shard::fullscreen writes), then drawn into, all scissored.
  const rect = view.rect && clearRect !== undefined
  const pass = ctx.encoder.beginRenderPass({
    label,
    colorAttachments: [],
    depthStencilAttachment: {
      view: target,
      depthLoadOp: rect ? 'load' : 'clear',
      depthClearValue: 0,
      depthStoreOp: 'store',
    },
    timestampWrites: ctx.timestamps(label),
  })
  if (rect) {
    const r = view.rects
    pass.setScissorRect(r[0]!, r[1]!, r[2]! - r[0]!, r[3]! - r[1]!)
    pass.setPipeline(clearRect)
    pass.draw(3)
  }
  const draws0 = view.draws
  const instances = draws0.cullView >= 0 ? store.gpuBindGroup : store.bindGroup
  if (!instances || !uniforms.bindGroup) {
    if (foliage && cam && uniforms.bindGroup) foliage.drawShadow(ctx, cam, pass, offset, cascade)
    pass.end()
    return
  }
  const args = world.resource(Culler).args.buffer
  pass.setBindGroup(0, uniforms.bindGroup, [offset])
  pass.setBindGroup(2, instances)
  let current: GPURenderPipeline | undefined
  let boundMaterial: GPUBindGroup | undefined
  let boundPositions: GPUBuffer | undefined
  let boundTangents: GPUBuffer | undefined
  let boundIndices: GPUBuffer | undefined
  const draws = view.draws
  for (let d = 0; d < draws.length; d++) {
    const item = draws.items[d]!
    // A type whose shader or pipeline failed casts through the standard pipeline (0061).
    const fallback = pipelines.failing(item.batch.material.type)
    const material = fallback ? pipelines.proxy(item.batch.material) : item.batch.material
    const type = material.type
    const variant = materialVariant(material)
    const masked = type.standard && variantBlend(variant) === 'mask'
    const key = ((PASS_SHADOW * 1024 + typeOrdinal(type)) * 16 + variant) * 8
    let pipeline = pipelines.cached(key)
    if (!pipeline) {
      const module = pipelines.module(world, gpu, type, 8, 'shard::pbr::shadow', undefined)
      if (!module) {
        if (!fallback && pipelines.failing(type)) d--
        else gpu.pipelines.skipped++
        continue
      }
      pipeline = pipelines.create(
        gpu,
        key,
        {
          label: `shadow/${type.name}/${masked ? 'mask' : 'opaque'}/${variantCull(variant)}`,
          layout: gpu.layouts.pipelineLayout({
            label: `shadow/${type.name}`,
            bindGroupLayouts: [shadowView, assets.layoutOf(type), store.layout],
          }),
          vertex: { module, entryPoint: 'vs', buffers: SHADOW_BUFFERS },
          fragment: masked ? { module, entryPoint: 'fs_mask', targets: [] } : undefined,
          primitive: {
            topology: 'triangle-list',
            cullMode: variantCull(variant),
            frontFace: 'ccw',
          },
          depthStencil: {
            format: 'depth32float',
            depthWriteEnabled: true,
            depthCompare: 'greater',
          },
        },
        type,
      )
      if (!pipeline) {
        if (!fallback && pipelines.failing(type)) d--
        continue
      }
    }
    const mat = assets.material(world, material)
    if (!mat?.bindGroup) continue
    const gm = assets.mesh(item.batch.mesh)
    if (pipeline !== current) {
      pass.setPipeline(pipeline)
      current = pipeline
      boundMaterial = undefined
    }
    // Consecutive draws often share these (terrain chunks share one set of buffers).
    if (mat.bindGroup !== boundMaterial) {
      pass.setBindGroup(1, mat.bindGroup)
      boundMaterial = mat.bindGroup
    }
    if (gm.positions !== boundPositions || gm.tangents !== boundTangents) {
      pass.setVertexBuffer(0, gm.positions)
      pass.setVertexBuffer(1, gm.normals)
      pass.setVertexBuffer(2, gm.uvs)
      pass.setVertexBuffer(3, gm.uvs1)
      pass.setVertexBuffer(4, gm.tangents)
      boundPositions = gm.positions
      boundTangents = gm.tangents
    }
    if (gm.indices) {
      if (gm.indices !== boundIndices) {
        pass.setIndexBuffer(gm.indices, gm.indexFormat)
        boundIndices = gm.indices
      }
      if (item.indirect >= 0) pass.drawIndexedIndirect(args, item.indirect)
      else pass.drawIndexed(gm.count, item.count, gm.firstIndex, gm.baseVertex, item.first)
    } else if (item.indirect >= 0) {
      pass.drawIndirect(args, item.indirect)
    } else {
      pass.draw(gm.count, item.count, 0, item.first)
    }
  }
  // GPU foliage (0045) casts into the camera's cascades from its own instances.
  if (foliage && cam) foliage.drawShadow(ctx, cam, pass, offset, cascade)
  pass.end()
}

const PASS_SHADOW = 2

/** Culls instances that cast shadows into a shadow view, and unions their world bounds. */
export function cullCasters(
  world: World,
  view: ShadowViewDraw,
  planes: Float32Array,
  box?: Float32Array,
): boolean {
  const store = world.resource(Instances)
  store.cull(view.draws, planes, InstanceFlags.Caster, box)
  return view.draws.visible > 0
}

export const ShadowsResource = defineResource<{
  local: LocalShadows
  uniforms: ShadowPassUniforms
}>('render/Shadows', { description: 'Spot and point shadow maps, shared by all cameras.' })
