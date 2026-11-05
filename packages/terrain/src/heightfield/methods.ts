import { type Entity, findComponent, ShardError, type World } from '@aethervtt/shard-core'
import { TerrainWorld } from '../heights'
import { tilesOf } from './colliders'
import { type HeightfieldEditor, terrainEditor } from './editor'
import type { EditChange, ShapeEdit, StrokeOptions } from './edits'
import { keyX, keyZ } from './pages'
import { finestPage, heightfieldSample, loadTerrainRegion, pageHeight } from './queries'
import type { HeightfieldRender } from './render'
import type { HeightfieldRuntime } from './runtime'

const round = (v: number, digits = 3) => {
  const k = 10 ** digits
  return Math.round(v * k) / k
}

function scenePath(world: World, entity: Entity): string | null {
  const member = findComponent('scene/SceneMember')
  if (!member || !world.isAlive(entity)) return null
  const v = world.tryGet(entity, member) as { path?: string } | undefined
  return v?.path || null
}

/** A heightfield from an entity id or scene path; the only one when omitted. */
export function resolveHeightfield(world: World, ref: unknown): HeightfieldRuntime {
  const all = world.tryResource(TerrainWorld)?.heightfields
  if (!all || all.size === 0) {
    throw new ShardError('terrain/no-terrain', 'There is no terrain/Terrain in the world', {
      hint: 'Add terrain/Terrain (with a Grid and a *.terrain.json source) to an entity.',
    })
  }
  if (ref === undefined || ref === null || ref === '') {
    if (all.size > 1) {
      throw new ShardError('terrain/which-terrain', `There are ${all.size} terrains; name one`, {
        hint: 'Pass terrain: an entity id or a scene path (terrain.describe lists them).',
      })
    }
    return [...all.values()][0]!
  }
  for (const rt of all.values()) {
    if (rt.entity === ref) return rt
    const path = scenePath(world, rt.entity)
    if (typeof ref === 'string' && path && (path === ref || path.endsWith(`/${ref}`))) return rt
  }
  throw new ShardError('terrain/not-a-terrain', `No terrain matches ${JSON.stringify(ref)}`, {
    hint: 'terrain.describe lists every terrain with its entity and scene path.',
  })
}

function usable(rt: HeightfieldRuntime): void {
  if (rt.problem) throw rt.problem
  if (!rt.ready) {
    throw new ShardError(
      'terrain/not-ready',
      `The terrain is waiting for ${rt.waiting ?? 'its source'}`,
      {
        hint: 'Its source and assets load asynchronously; step a frame and ask again.',
      },
    )
  }
}

/** `terrain.describe` for one heightfield (spec 0071). */
export function describeHeightfield(world: World, rt: HeightfieldRuntime) {
  const layout = rt.layout
  const r = rt.parts.get('render') as HeightfieldRender | undefined
  const byDepth: Record<number, number> = {}
  let partial = 0
  for (let i = 0; i < rt.selection.renderedCount; i++) {
    const n = rt.selection.rendered[i]!
    const d = rt.tree.depth[n]!
    byDepth[d] = (byDepth[d] ?? 0) + 1
    if (rt.tree.mask[n] !== 15) partial++
  }
  const blocks = layout ? layout.blocksX * layout.blocksZ : 0
  const records = rt.manifest?.blocks ?? {}
  const current = rt.bake === 'current' ? Object.keys(records).length : 0
  const tiles = tilesOf(rt)
  let resident = 0
  if (rt.pages && layout) {
    for (const page of rt.pages.pages()) if (page.depth <= rt.residentDepth) resident++
  }
  return {
    entity: rt.entity,
    path: scenePath(world, rt.entity),
    source: rt.settings?.source?.path ?? rt.settings?.source?.guid ?? null,
    ready: rt.ready,
    streaming: rt.streaming,
    waitingFor: rt.waiting,
    problem: rt.problem ? rt.problem.toJSON() : null,
    size: layout ? [layout.sizeX, layout.sizeZ] : null,
    spacing: layout?.spacing ?? null,
    heightRange: rt.asset ? rt.asset.source.heightRange : null,
    roots: layout ? { x: layout.rootsX, z: layout.rootsZ, size: layout.rootSize } : null,
    depths: layout ? layout.depth + 1 : 0,
    version: rt.version,
    bake: {
      state: rt.bake,
      blocks,
      current,
      stale: rt.bake === 'current' ? blocks - current : blocks,
      baking: rt.bake === 'baking' ? blocks : 0,
      lastBake: rt.lastBake
        ? {
            rebaked: rt.lastBake.rebaked,
            pages: rt.lastBake.pages,
            ms: Math.round(rt.lastBake.ms),
            msPerBlock: Math.round(rt.lastBake.msPerBlock),
            outOfRange: rt.lastBake.outOfRange,
          }
        : null,
    },
    detail: {
      errorPixels: rt.settings?.errorPixels ?? null,
      vertexPixels: rt.settings?.vertexPixels ?? null,
      lodBias: round(rt.lodBias),
      errors: Array.from(rt.errors, (e) => round(e)),
    },
    selected: {
      chunks: rt.selection.renderedCount,
      byDepth,
      partial,
      requested: rt.selection.requestedCount,
      waiting: rt.selection.waiting,
    },
    pages: {
      residentDepth: rt.residentDepth,
      resident,
      cached: rt.pages?.cached ?? 0,
      readsInFlight: rt.pages?.pendingReads ?? 0,
      reads: rt.pages?.stats.reads ?? 0,
      bytesRead: rt.pages?.stats.bytesRead ?? 0,
      bakedInline: rt.pages?.stats.bakedInline ?? 0,
    },
    pool: r
      ? {
          slots: r.capacity,
          used: r.used,
          uploaded: r.stats.uploaded,
          uploadedLastFrame: r.stats.uploadedLastFrame,
          waitingToUpload: r.arrived.length,
          evicted: r.stats.evicted,
        }
      : null,
    colliders: {
      tiles: tiles.tiles.size,
      active: [...tiles.tiles.values()].filter((t) => t.entity >= 0).length,
      pending: tiles.due.size,
      fromPages: tiles.fromPages,
      bakedInline: tiles.bakedInline,
      anchors: rt.anchors,
    },
    edits: describeEdits(rt),
  }
}

/** `terrain.describe`'s edits (0104): tiles, the save data's size, pending pages, history. */
function describeEdits(rt: HeightfieldRuntime) {
  const edits = rt.edits
  if (!edits) return null
  const editor = rt.parts.get('editor') as HeightfieldEditor | undefined
  return {
    sculptTiles: edits.sculpt.size,
    paintTiles: edits.paint.size,
    at: rt.asset ? rt.asset.source.edits : null,
    pending: editor?.pending ?? 0,
    lastRebaked: editor?.lastRebaked ?? 0,
    lastMs: round(editor?.lastMs ?? 0, 2),
    editedPages: rt.pages?.overrideCount ?? 0,
    undo: edits.undoDepth,
    redo: edits.redoDepth,
  }
}

/**
 * `terrain.edit` (0104): a shape edit, or a stroke along points, then waits (up to `waitMs`) for
 * the terrain to show it. Returns the rectangle it changed and what's still pending.
 */
export async function editHeightfield(
  world: World,
  rt: HeightfieldRuntime,
  p: { edit?: unknown; stroke?: unknown },
  waitMs = 10_000,
) {
  usable(rt)
  const editor = terrainEditor(world, rt.entity)
  if ((p.edit === undefined) === (p.stroke === undefined)) {
    throw new ShardError('terrain/bad-edit', 'Pass an edit (a shape) or a stroke (points)', {
      hint: 'e.g. { "edit": { "shape": { "circle": { "at": [300, 300], "radius": 10 } }, "raise": 2 } } or { "stroke": { "brush": "smooth", "radius": 8, "strength": 0.5, "points": [[300, 300], [340, 310]] } }.',
    })
  }
  let change: EditChange | null
  if (p.edit !== undefined) change = editor.shape(p.edit as ShapeEdit)
  else {
    const { points, ...options } = p.stroke as StrokeOptions & { points?: unknown }
    if (!Array.isArray(points) || points.length === 0)
      throw new ShardError('terrain/bad-edit', 'A stroke needs points: [[x, z], …]', {
        path: '/stroke/points',
      })
    const [first, ...rest] = points as [number, number][]
    const stroke = editor.stroke(options, first![0], first![1])
    for (const [x, z] of rest) stroke.to(x, z)
    change = stroke.end()
  }
  return { ...(await settleEdits(rt, waitMs)), clamped: change?.clamped ?? false }
}

/** Waits for the edits so far to be in; returns the last edit's leaves and what's pending. */
async function settleEdits(rt: HeightfieldRuntime, waitMs: number) {
  const editor = rt.parts.get('editor') as HeightfieldEditor | undefined
  const start = performance.now()
  while (editor?.busy && performance.now() - start < waitMs)
    await new Promise((r) => setTimeout(r, 16))
  const leaves = editor?.lastLeaves ?? []
  const size = rt.layout!.leafSize
  let rect: [number, number, number, number] | null = null
  for (const key of leaves) {
    const x = keyX(key) * size
    const z = keyZ(key) * size
    rect = rect
      ? [
          Math.min(rect[0], x),
          Math.min(rect[1], z),
          Math.max(rect[2], x + size),
          Math.max(rect[3], z + size),
        ]
      : [x, z, x + size, z + size]
  }
  return { rebakedLeaves: leaves.length, leavesRect: rect, pending: editor?.pending ?? 0 }
}

/** `terrain.undo` / `terrain.redo`. */
export async function undoHeightfield(world: World, rt: HeightfieldRuntime, redo: boolean) {
  usable(rt)
  const editor = terrainEditor(world, rt.entity)
  const change = redo ? editor.redo() : editor.undo()
  return {
    done: change !== null,
    ...(await settleEdits(rt, 10_000)),
    undo: editor.edits.undoDepth,
    redo: editor.edits.redoDepth,
  }
}

/** `terrain.sample` on a heightfield: loads the leaf pages under the points first. */
export async function sampleHeightfield(world: World, rt: HeightfieldRuntime, points: number[][]) {
  usable(rt)
  for (const [x, z] of points) {
    await loadTerrainRegion(world, rt.entity, [x! - 1, z! - 1, x! + 1, z! + 1])
  }
  return points.map(([x, z]) => {
    const s = heightfieldSample(rt, x!, z!)
    return {
      x: x!,
      z: z!,
      height: round(s.height),
      normal: s.normal.map((v) => round(v, 4)),
      slope: round(s.slope, 2),
      layers: s.layers,
      share: round(s.share, 3),
      depth: s.depth,
    }
  })
}

/**
 * A top-down image of a heightfield (`terrain.map`), `width` pixels across, +Z down the image:
 * `height` dark lowlands to white peaks, `slope` flat black to cliffs white, `layers` the heaviest
 * paint layer's tint, `bake` blocks by state (green current, amber stale, cyan dirtied by the last
 * bake; magenta leaves the last edit rebaked, 0104), from the finest pages held (the coarse levels
 * always are).
 */
export function heightfieldMap(rt: HeightfieldRuntime, width: number, mode: string) {
  usable(rt)
  const layout = rt.layout!
  const height = Math.max(1, Math.round((width * layout.sizeZ) / layout.sizeX))
  const data = new Uint8Array(width * height * 4)
  const lo = rt.lo
  const hi = rt.hi
  const tints = rt.asset!.source.layers.map((l) => l.tint)
  const dirtied = new Set(rt.dirtied)
  const blockSize = layout.block * layout.leafSize
  // Leaves the last edit rebaked (0104), as "x,z".
  const edited = new Set(
    ((rt.parts.get('editor') as HeightfieldEditor | undefined)?.lastLeaves ?? []).map(
      (k) => `${keyX(k)},${keyZ(k)}`,
    ),
  )
  for (let py = 0; py < height; py++) {
    const z = ((py + 0.5) / height) * layout.sizeZ
    for (let px = 0; px < width; px++) {
      const x = ((px + 0.5) / width) * layout.sizeX
      const o = (py * width + px) * 4
      let r = 0
      let g = 0
      let b = 0
      if (mode === 'bake') {
        const id = `${Math.floor(x / blockSize)},${Math.floor(z / blockSize)}`
        const current = rt.manifest?.blocks[id] !== undefined && rt.bake === 'current'
        ;[r, g, b] = dirtied.has(id) ? [60, 200, 230] : current ? [70, 170, 80] : [220, 160, 40]
        if (edited.has(`${Math.floor(x / layout.leafSize)},${Math.floor(z / layout.leafSize)}`))
          [r, g, b] = [230, 90, 200]
        // Block borders.
        const fx = (x / blockSize) % 1
        const fz = (z / blockSize) % 1
        if (fx < 0.02 || fz < 0.02) [r, g, b] = [r * 0.5, g * 0.5, b * 0.5]
      } else {
        const page = finestPage(rt, x, z)
        if (page) {
          if (mode === 'slope' || mode === 'layers') {
            const s = heightfieldSample(rt, x, z)
            if (mode === 'slope') r = g = b = Math.min(255, (s.slope / 60) * 255)
            else {
              const names = rt.asset!.source.layers.map((l) => l.name)
              const ta = tints[names.indexOf(s.layers[0])] ?? [1, 0, 1]
              const tb = tints[names.indexOf(s.layers[1])] ?? ta
              const t = s.share
              r = (ta[0] * (1 - t) + tb[0] * t) ** (1 / 2.2) * 255
              g = (ta[1] * (1 - t) + tb[1] * t) ** (1 / 2.2) * 255
              b = (ta[2] * (1 - t) + tb[2] * t) ** (1 / 2.2) * 255
            }
          } else {
            const k = Math.min(1, Math.max(0, (pageHeight(rt, page, x, z) - lo) / (hi - lo)))
            r = 30 + 225 * k
            g = 50 + 205 * k
            b = 30 + 225 * k
          }
        }
      }
      data[o] = r
      data[o + 1] = g
      data[o + 2] = b
      data[o + 3] = 255
    }
  }
  return { width, height, data }
}
