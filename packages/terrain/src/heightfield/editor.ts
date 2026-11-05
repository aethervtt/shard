import { defineEvent, defineSystem, type Entity, type World } from '@aethervtt/shard-core'
import { Collider } from '@aethervtt/shard-physics'
import { TerrainBudget } from '../components'
import { TerrainWorld } from '../heights'
import { tileHeights, tilesOf } from './colliders'
import type {
  EditCause,
  EditChange,
  EditStroke,
  LatticeRect,
  ShapeEdit,
  StrokeOptions,
  TerrainEdits,
  TerrainEditsData,
} from './edits'
import { dequantize, LEAF_SIDE, normalByte, PAGE, pageNormal, SIDE } from './kernel'
import { keyX, keyZ, type LoadedPage, nodeKey } from './pages'
import { heightfieldRuntime } from './queries'
import { rewriteHeightfieldPage } from './render'
import type { HeightfieldRuntime } from './runtime'
import { mainNoise } from './stack'

/** What an edit changed, once the terrain shows it (spec 0104). */
export interface TerrainEditedData {
  terrain: Entity
  /** [x0, z0, x1, z1] metres in the terrain's frame, covering every changed sample. */
  rect: [number, number, number, number]
  height: boolean
  paint: boolean
  cause: EditCause
  /** Some heights were held at heightRange. */
  clamped: boolean
}

export const TerrainEdited = defineEvent<TerrainEditedData>('terrain/Edited', {
  description:
    'A terrain edit is in (spec 0104): its pages, colliders and GPU pool show it. One per shape, undo, redo or load, and one per frame of a stroke.',
})

interface PendingEdit extends Omit<TerrainEditedData, 'terrain'> {
  frame: number
}

/**
 * The runtime side of a heightfield's edits (spec 0104): leaves queued by edits, rebaked within
 * `TerrainBudget.editMs` a frame into the page store's overrides; then their ancestors, node
 * bounds and errors, the GPU pool, colliders, and the edit's event.
 */
export class HeightfieldEditor {
  private readonly rt: HeightfieldRuntime
  /** Leaves to rebake, in order (from `head`), and the set of them. */
  private leaves: number[] = []
  private head = 0
  private readonly queued = new Set<number>()
  /**
   * What changed in each queued leaf: leaf samples (global), and whether only paint did. A leaf
   * on the CPU rebakes just those (and the control texels over them); others rebake whole.
   */
  private readonly dirty = new Map<number, { rect: LatticeRect; paintOnly: boolean }>()
  /**
   * Leaf samples whose heights, normals or paint changed since ancestors were last rebuilt: the
   * texels of every level they reach are patched once the leaves are done.
   */
  private rect: LatticeRect | null = null
  /**
   * Leaves rebaked since their ancestors were last rebuilt, with the leaf-local vertices that
   * changed: their errors are measured then.
   */
  private fresh: { page: LoadedPage; i0: number; j0: number; i1: number; j1: number }[] = []
  private edits: PendingEdit[] = []
  /** Pages rebaked in the last processed frame (leaves and ancestors). */
  lastRebaked = 0
  lastMs = 0
  /** Leaf keys the last edit rebaked (terrain.map's bake mode). */
  lastLeaves: number[] = []

  constructor(rt: HeightfieldRuntime) {
    this.rt = rt
  }

  /** Leaves and ancestors still to rebuild. */
  get pending(): number {
    return this.leaves.length - this.head + (this.rect ? 1 : 0)
  }

  /** Work to do: pages to rebuild, or edits whose events are still to send. */
  get busy(): boolean {
    return this.pending > 0 || this.edits.length > 0
  }

  /** Queues what a change touched: leaves whose samples, border or control texels it changed. */
  changed(change: EditChange, cause: EditCause, frame: number): void {
    const l = this.rt.layout!
    const rect: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity]
    const queue = (
      x0: number,
      z0: number,
      x1: number,
      z1: number,
      samples: LatticeRect,
      paint: boolean,
    ) => {
      for (let z = Math.max(0, z0); z <= Math.min(l.leavesZ - 1, z1); z++) {
        for (let x = Math.max(0, x0); x <= Math.min(l.leavesX - 1, x1); x++) {
          const key = nodeKey(l.depth, x, z)
          const d = this.dirty.get(key)
          if (d) {
            growRect(d.rect, samples[0], samples[1], samples[2], samples[3])
            d.paintOnly &&= paint
          } else this.dirty.set(key, { rect: [...samples], paintOnly: paint })
          if (this.queued.has(key)) continue
          this.queued.add(key)
          this.leaves.push(key)
        }
      }
    }
    const cover = (r: [number, number, number, number], unit: number) => {
      rect[0] = Math.min(rect[0], r[0] * unit)
      rect[1] = Math.min(rect[1], r[1] * unit)
      rect[2] = Math.max(rect[2], r[2] * unit)
      rect[3] = Math.max(rect[3], r[3] * unit)
    }
    if (change.sculpt) {
      const [i0, j0, i1, j1] = change.sculpt
      // A leaf holds samples X·PAGE − 1 to X·PAGE + PAGE + 1 (its border, for normals and slopes).
      queue(
        Math.ceil((i0 - PAGE - 1) / PAGE),
        Math.ceil((j0 - PAGE - 1) / PAGE),
        Math.floor((i1 + 1) / PAGE),
        Math.floor((j1 + 1) / PAGE),
        change.sculpt,
        false,
      )
      cover(change.sculpt, l.spacing)
      // Leaf normals reach a sample past the heights.
      if (l.depth > 0) this.rect = growRect(this.rect, i0 - 1, j0 - 1, i1 + 1, j1 + 1)
    }
    if (change.paint) {
      const [p0, q0, p1, q1] = change.paint
      const c = l.cells
      const k = l.paintStep
      queue(
        Math.ceil((p0 - c) / c),
        Math.ceil((q0 - c) / c),
        Math.floor(p1 / c),
        Math.floor(q1 / c),
        [p0 * k, q0 * k, p1 * k, q1 * k],
        true,
      )
      cover(change.paint, l.paintSpacing)
      if (l.depth > 0) this.rect = growRect(this.rect, p0 * k, q0 * k, p1 * k, q1 * k)
    }
    // A stroke's changes in one frame are one edit.
    const last = this.edits[this.edits.length - 1]
    if (last && cause === 'stroke' && last.cause === 'stroke' && last.frame === frame) {
      last.rect[0] = Math.min(last.rect[0], rect[0])
      last.rect[1] = Math.min(last.rect[1], rect[1])
      last.rect[2] = Math.max(last.rect[2], rect[2])
      last.rect[3] = Math.max(last.rect[3], rect[3])
      last.height ||= change.sculpt !== null
      last.paint ||= change.paint !== null
      last.clamped ||= change.clamped
      return
    }
    this.edits.push({
      rect,
      height: change.sculpt !== null,
      paint: change.paint !== null,
      cause,
      clamped: change.clamped,
      frame,
    })
  }

  /** Rebakes queued leaves within `budgetMs` (at least one), then ancestors, then sends events. */
  process(world: World, budgetMs: number): void {
    const rt = this.rt
    const pages = rt.pages!
    const t0 = performance.now()
    let rebaked = 0
    if (this.head < this.leaves.length) {
      while (this.head < this.leaves.length) {
        if (rebaked > 0 && performance.now() - t0 >= budgetMs) break
        const key = this.leaves[this.head++]!
        this.queued.delete(key)
        const d = this.dirty.get(key)
        const page = this.rebakeLeaf(key)
        pages.override(page)
        this.commit(world, page)
        const lx = page.x * PAGE
        const lz = page.z * PAGE
        this.fresh.push(
          d
            ? {
                page,
                i0: Math.max(0, d.rect[0] - lx),
                j0: Math.max(0, d.rect[1] - lz),
                i1: Math.min(PAGE, d.rect[2] - lx),
                j1: Math.min(PAGE, d.rect[3] - lz),
              }
            : { page, i0: 0, j0: 0, i1: PAGE, j1: PAGE },
        )
        this.lastLeaves.push(key)
        rebaked++
      }
      if (this.head === this.leaves.length) {
        this.leaves = []
        this.head = 0
      }
    }
    if (this.head === this.leaves.length && this.rect) rebaked += this.rebuildAncestors(world)
    if (rebaked > 0) {
      this.lastRebaked = rebaked
      this.lastMs = performance.now() - t0
    }
    if (this.pending === 0 && this.edits.length > 0) this.send(world)
  }

  /** A queued leaf rebaked: just what changed when it's on the CPU and that's a part of it. */
  private rebakeLeaf(key: number): LoadedPage {
    const rt = this.rt
    const pages = rt.pages!
    const d = this.dirty.get(key)
    this.dirty.delete(key)
    const x = keyX(key)
    const z = keyZ(key)
    const held = pages.get(key)
    if (d && held) {
      const [i0, j0, i1, j1] = d.rect
      const lx = x * PAGE
      const lz = z * PAGE
      // Leaf-local, with the border (−1 to PAGE + 1).
      const area =
        (Math.min(i1 - lx, PAGE + 1) - Math.max(i0 - lx, -1)) *
        (Math.min(j1 - lz, PAGE + 1) - Math.max(j0 - lz, -1))
      if (area < (LEAF_SIDE * LEAF_SIDE) / 2)
        return pages.patchLeaf(
          mainNoise(),
          rt.stack!,
          held,
          i0 - lx,
          j0 - lz,
          i1 - lx,
          j1 - lz,
          d.paintOnly,
        )
    }
    return pages.bakeLeaf(mainNoise(), rt.stack!, x, z)
  }

  /** A rebuilt page's node bounds, its GPU pool slot, and (a leaf's) collider tile. */
  private commit(world: World, page: LoadedPage): void {
    const rt = this.rt
    const n = rt.nodeOf(page.depth, page.x, page.z)
    if (n >= 0)
      rt.tree.setHeights(n, dequantize(page.min, rt.lo, rt.hi), dequantize(page.max, rt.lo, rt.hi))
    rewriteHeightfieldPage(world, rt, page)
    if (!page.leaf) return
    const tile = tilesOf(rt).tiles.get(page.key)
    if (!tile) return
    tileHeights(rt, page, tile.heights)
    if (tile.entity >= 0 && world.isAlive(tile.entity)) {
      const c = world.get(tile.entity, Collider)
      world.set(tile.entity, Collider, {
        ...c,
        heightfield: { rows: SIDE, cols: SIDE, heights: tile.heights.slice() },
      })
    }
  }

  /**
   * Rebuilds the ancestors over the changed samples, deepest first: in each, only the texels the
   * change reaches (heights and paint as point samples of the children, normals as 0071's [1 2 1]²
   * average of theirs, which reaches 2^L samples at level L). Every page it reads must be on the
   * CPU: missing ones are read here, and the rebuild waits a frame. Then the fresh leaves' errors
   * against their new ancestors. Returns pages rebuilt.
   */
  private rebuildAncestors(world: World): number {
    const rt = this.rt
    const pages = rt.pages!
    const D = rt.layout!.depth
    const r = this.rect!
    // Each level's nodes over the change, and their reach in leaf samples.
    const levels: { d: number; s: number; X0: number; Z0: number; X1: number; Z1: number }[] = []
    let missing = false
    for (let d = D - 1; d >= 0; d--) {
      const s = 2 ** (D - d)
      const span = PAGE * s
      const [nx, nz] = pages.nodesAt(d)
      const level = {
        d,
        s,
        X0: Math.max(0, Math.floor((r[0] - s) / span)),
        Z0: Math.max(0, Math.floor((r[1] - s) / span)),
        X1: Math.min(nx - 1, Math.floor((r[2] + s) / span)),
        Z1: Math.min(nz - 1, Math.floor((r[3] + s) / span)),
      }
      levels.push(level)
      const [cx, cz] = pages.nodesAt(d + 1)
      for (let Z = level.Z0; Z <= level.Z1; Z++) {
        for (let X = level.X0; X <= level.X1; X++) {
          if (!pages.get(nodeKey(d, X, Z))) {
            missing = true
            void pages.load(d, X, Z).catch(() => {})
          }
          for (let k = 0; k < 16; k++) {
            const x = 2 * X + (k % 4) - 1
            const z = 2 * Z + Math.floor(k / 4) - 1
            if (x < 0 || z < 0 || x >= cx || z >= cz || pages.get(nodeKey(d + 1, x, z))) continue
            missing = true
            void pages.load(d + 1, x, z).catch(() => {})
          }
        }
      }
    }
    if (missing) return 0
    let built = 0
    const ring: (LoadedPage | null)[] = new Array(16).fill(null)
    for (const { d, s, X0, Z0, X1, Z1 } of levels) {
      const span = PAGE * s
      const [cx, cz] = pages.nodesAt(d + 1)
      for (let Z = Z0; Z <= Z1; Z++) {
        for (let X = X0; X <= X1; X++) {
          const i0 = Math.max(0, Math.ceil((r[0] - s - X * span) / s))
          const j0 = Math.max(0, Math.ceil((r[1] - s - Z * span) / s))
          const i1 = Math.min(PAGE, Math.floor((r[2] + s - X * span) / s))
          const j1 = Math.min(PAGE, Math.floor((r[3] + s - Z * span) / s))
          if (i1 < i0 || j1 < j0) continue
          for (let k = 0; k < 16; k++) {
            const x = 2 * X + (k % 4) - 1
            const z = 2 * Z + Math.floor(k / 4) - 1
            ring[k] =
              x < 0 || z < 0 || x >= cx || z >= cz
                ? null
                : (pages.get(nodeKey(d + 1, x, z)) ?? null)
          }
          const page = this.patch(pages.get(nodeKey(d, X, Z))!, ring, i0, j0, i1, j1)
          pages.override(page)
          this.commit(world, page)
          built++
        }
      }
    }
    this.rect = null
    this.measureErrors()
    return built
  }

  /**
   * A parent page with texels [i0, i1] × [j0, j1] (and the control texels over them) rebuilt from
   * its children and the ring around them, as 0071's parentPage builds a whole one; the rest kept.
   */
  private patch(
    old: LoadedPage,
    ring: readonly (LoadedPage | null)[],
    i0: number,
    j0: number,
    i1: number,
    j1: number,
  ): LoadedPage {
    const cells = this.rt.layout!.cells
    const heights = old.heights.slice()
    const normals = old.normals.slice()
    const control = old.control.slice()
    const kids = [ring[5]!, ring[6]!, ring[9]!, ring[10]!]
    const normalAt = ringNormalBytes(ring)
    const v = this.v
    for (let j = j0; j <= j1; j++) {
      const gj = 2 * j
      const cz = gj > PAGE ? 1 : 0
      for (let i = i0; i <= i1; i++) {
        const gi = 2 * i
        const cx = gi > PAGE ? 1 : 0
        const c = kids[cz * 2 + cx]
        const ci = gi - cx * PAGE
        const cj = gj - cz * PAGE
        heights[j * SIDE + i] = !c
          ? 0
          : c.leaf
            ? c.heights[(cj + 1) * LEAF_SIDE + ci + 1]!
            : c.heights[cj * SIDE + ci]!
        let sx = 0
        let sy = 0
        let sz = 0
        for (let b = -1; b <= 1; b++) {
          for (let a = -1; a <= 1; a++) {
            const wgt = (2 - Math.abs(a)) * (2 - Math.abs(b))
            normalAt(gi + a, gj + b, v)
            sx += v[0]! * wgt
            sy += v[1]! * wgt
            sz += v[2]! * wgt
          }
        }
        const l = Math.sqrt(sx * sx + sy * sy + sz * sz) || 1
        normals[j * SIDE + i] = normalByte(sx / l)
        normals[SIDE * SIDE + j * SIDE + i] = normalByte(sz / l)
      }
    }
    // Control texels over the patched vertices (PAGE / cells vertices apart).
    const per = PAGE / cells
    for (let b = Math.floor(j0 / per); b <= Math.min(cells, Math.ceil(j1 / per)); b++) {
      const cb = 2 * b
      const cz = cb > cells ? 1 : 0
      for (let a = Math.floor(i0 / per); a <= Math.min(cells, Math.ceil(i1 / per)); a++) {
        const ca = 2 * a
        const cx = ca > cells ? 1 : 0
        const c = kids[cz * 2 + cx]
        if (!c) continue
        const src = ((cb - cz * cells) * (cells + 1) + (ca - cx * cells)) * 4
        control.set(c.control.subarray(src, src + 4), (b * (cells + 1) + a) * 4)
      }
    }
    let min = 65535
    let max = 0
    for (const c of kids) {
      if (!c) continue
      min = Math.min(min, c.min)
      max = Math.max(max, c.max)
    }
    return {
      key: old.key,
      depth: old.depth,
      x: old.x,
      z: old.z,
      leaf: false,
      heights,
      normals,
      control,
      texels: undefined,
      min,
      max,
      error: old.error,
    }
  }

  private readonly v = new Float64Array(3)

  /**
   * Raises a depth's error where fresh leaves stray farther from an ancestor's surface than the
   * bake measured (never lowers one): selection then refines over a new cliff.
   */
  private measureErrors(): void {
    const rt = this.rt
    const layout = rt.layout!
    const D = layout.depth
    let raised = false
    const scale = (rt.hi - rt.lo) / 65535
    for (const { page: leaf, i0, j0, i1, j1 } of this.fresh) {
      if (i1 < i0 || j1 < j0) continue
      for (let d = D - 1; d >= 0; d--) {
        const anc = rt.pages!.get(nodeKey(d, leaf.x >> (D - d), leaf.z >> (D - d)))
        if (!anc) continue
        // The leaf's vertices against the ancestor's triangles (pageHeight's, inlined), in u16
        // steps: an ancestor vertex spans `span` leaf samples.
        const span = 2 ** (D - d)
        const ox = (leaf.x % span) * PAGE
        const oz = (leaf.z % span) * PAGE
        const ah = anc.heights
        const lh = leaf.heights
        let worst = 0
        for (let j = j0; j <= j1; j++) {
          const fz = (oz + j) / span
          const cj = Math.min(PAGE - 1, Math.floor(fz))
          const v = fz - cj
          for (let i = i0; i <= i1; i++) {
            const fx = (ox + i) / span
            const ci = Math.min(PAGE - 1, Math.floor(fx))
            const u = fx - ci
            const a = cj * SIDE + ci
            const h00 = ah[a]!
            const h10 = ah[a + 1]!
            const h01 = ah[a + SIDE]!
            const h11 = ah[a + SIDE + 1]!
            const surface =
              u + v <= 1
                ? h00 + u * (h10 - h00) + v * (h01 - h00)
                : h11 + (1 - u) * (h01 - h11) + (1 - v) * (h10 - h11)
            const e = Math.abs(lh[(j + 1) * LEAF_SIDE + i + 1]! - surface)
            if (e > worst) worst = e
          }
        }
        worst *= scale
        // rawErrors[d + 1] is how far depth d + 1's detail is from depth d's surface.
        if (worst > rt.rawErrors[d + 1]!) {
          rt.rawErrors[d + 1] = worst
          raised = true
        }
      }
    }
    this.fresh = []
    if (!raised) return
    const raw = rt.rawErrors
    raw[0] = Math.max(raw[0]!, raw[1]! * 2)
    for (let d = raw.length - 2; d >= 0; d--) raw[d] = Math.max(raw[d]!, raw[d + 1]!)
    rt.capErrors()
  }

  private send(world: World): void {
    const rt = this.rt
    for (const e of this.edits) {
      rt.editLog.push(e.rect[0], e.rect[1], e.rect[2], e.rect[3])
      world.send(TerrainEdited, {
        terrain: rt.entity,
        rect: e.rect,
        height: e.height,
        paint: e.paint,
        cause: e.cause,
        clamped: e.clamped,
      })
    }
    this.edits = []
  }

  /** Starts a new record of which leaves the next edit rebakes. */
  resetLastLeaves(): void {
    this.lastLeaves = []
  }
}

/**
 * 0071's ring lookup for parentPage (bake.ts ringNormalAt), reading the children's normal bytes
 * per texel: a patch reads a few hundred texels, not worth unpacking whole pages for.
 */
function ringNormalBytes(
  ring: readonly (LoadedPage | null)[],
): (gi: number, gj: number, out: Float64Array) => void {
  return (gi, gj, out) => {
    let c = gi < 0 ? -1 : gi > 2 * PAGE ? 2 : gi === 2 * PAGE ? 1 : Math.floor(gi / PAGE)
    let r = gj < 0 ? -1 : gj > 2 * PAGE ? 2 : gj === 2 * PAGE ? 1 : Math.floor(gj / PAGE)
    let page = ring[(r + 1) * 4 + c + 1]
    if (!page) {
      // Past the terrain's edge: the nearest texel inside.
      gi = Math.min(2 * PAGE, Math.max(0, gi))
      gj = Math.min(2 * PAGE, Math.max(0, gj))
      c = gi === 2 * PAGE ? 1 : Math.floor(gi / PAGE)
      r = gj === 2 * PAGE ? 1 : Math.floor(gj / PAGE)
      page = ring[(r + 1) * 4 + c + 1]
    }
    if (!page) {
      out[0] = 0
      out[1] = 1
      out[2] = 0
      return
    }
    pageNormal(page as never, gi - c * PAGE, gj - r * PAGE, out)
  }
}

function growRect(
  r: LatticeRect | null,
  i0: number,
  j0: number,
  i1: number,
  j1: number,
): LatticeRect {
  if (!r) return [i0, j0, i1, j1]
  r[0] = Math.min(r[0], i0)
  r[1] = Math.min(r[1], j0)
  r[2] = Math.max(r[2], i1)
  r[3] = Math.max(r[3], j1)
  return r
}

/** A runtime's editor side, made on first use. */
export function heightfieldEditorOf(rt: HeightfieldRuntime): HeightfieldEditor {
  let e = rt.parts.get('editor') as HeightfieldEditor | undefined
  if (!e) {
    e = new HeightfieldEditor(rt)
    rt.parts.set('editor', e)
  }
  return e
}

/**
 * Rebakes what edits touched (spec 0104), within `TerrainBudget.editMs` a frame per terrain,
 * once its packs are current: leaves into the page store's overrides, then their ancestors,
 * bounds, errors, the GPU pool and colliders, then `TerrainEdited`.
 */
export const editHeightfields = defineSystem({
  name: 'terrain/heightfield-edits',
  description:
    'Rebakes the heightfield leaves edits touched (within TerrainBudget.editMs a frame), then their ancestors, node bounds, GPU pool pages and collider tiles, and sends terrain/Edited.',
  run: (_s, world) => {
    const state = world.resource(TerrainWorld)
    const budget = world.resource(TerrainBudget)
    for (const rt of state.heightfields.values()) {
      const e = rt.parts.get('editor') as HeightfieldEditor | undefined
      if (!e?.busy || !rt.ready || !rt.streaming || rt.bake !== 'current') continue
      e.process(world, budget.editMs)
    }
  },
})

/**
 * Edits on a heightfield terrain (spec 0104): strokes, shapes, undo and redo, saving and loading.
 * Edits land in the edit layers at once; the terrain shows them within a frame or two, and sends
 * `TerrainEdited` when it does.
 */
export class TerrainEditor {
  readonly rt: HeightfieldRuntime

  constructor(rt: HeightfieldRuntime) {
    this.rt = rt
  }

  get edits(): TerrainEdits {
    return this.rt.edits!
  }

  /** Starts a stroke at (x, z) in the terrain's frame; drag it with `to()`, finish with `end()`. */
  stroke(options: StrokeOptions, x: number, z: number): EditStroke {
    heightfieldEditorOf(this.rt).resetLastLeaves()
    return this.edits.stroke(options, x, z)
  }

  /** One shape edit: an undo step of its own. */
  shape(edit: ShapeEdit): EditChange {
    heightfieldEditorOf(this.rt).resetLastLeaves()
    return this.edits.shape(edit)
  }

  undo(): EditChange | null {
    heightfieldEditorOf(this.rt).resetLastLeaves()
    return this.edits.undo()
  }

  redo(): EditChange | null {
    heightfieldEditorOf(this.rt).resetLastLeaves()
    return this.edits.redo()
  }

  get canUndo(): boolean {
    return this.edits.canUndo
  }

  get canRedo(): boolean {
    return this.edits.canRedo
  }

  /** The edits as save data. */
  save(): TerrainEditsData {
    return this.edits.save()
  }

  /** Replaces the edits with saved ones (history cleared). */
  load(data: TerrainEditsData): EditChange {
    heightfieldEditorOf(this.rt).resetLastLeaves()
    return this.edits.load(data)
  }

  /** Leaves and ancestors still to rebake: 0 once every edit so far shows. */
  get pending(): number {
    return heightfieldEditorOf(this.rt).pending
  }

  /** The edit layer's height at (x, z): the stack below the edits plus the sculpt delta. */
  editHeightAt(x: number, z: number): number {
    return this.edits.editHeightAt(x, z)
  }
}

/** The editor of a Terrain entity; throws `terrain/not-ready` until its source is loaded. */
export function terrainEditor(world: World, terrain: Entity): TerrainEditor {
  const rt = heightfieldRuntime(world, terrain)
  let editor = rt.parts.get('api') as TerrainEditor | undefined
  if (!editor) {
    editor = new TerrainEditor(rt)
    rt.parts.set('api', editor)
  }
  return editor
}

/**
 * Loads saved edits into a terrain: now if it's ready (rebaking what they touch), else as soon as
 * its source is, ahead of its first bake (which then bakes them in).
 */
export function loadTerrainEdits(world: World, terrain: Entity, data: TerrainEditsData): void {
  const rt = world.tryResource(TerrainWorld)?.heightfields.get(terrain)
  if (rt?.ready && rt.edits) {
    terrainEditor(world, terrain).load(data)
    return
  }
  world.initResource(TerrainWorld).pendingEdits.set(terrain, data)
}
