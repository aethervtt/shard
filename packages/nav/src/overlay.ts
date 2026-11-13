import { defineOverlay, type GizmoStore } from '@aethervtt/shard-render'
import { GlobalTransform } from '@aethervtt/shard-transform'
import { BLOCKED as BLOCKED_STATUS } from './breach'
import type { NavMeshRuntime } from './navmesh'
import { type GridRecord, Nav } from './state'

/** Area colors: ground teal, then a hue per area code. */
function areaColor(area: number, out: Float32Array): Float32Array {
  if (area === 0) {
    out[0] = 0.2
    out[1] = 0.85
    out[2] = 0.75
  } else {
    const h = (area * 0.618034) % 1
    out[0] = 0.5 + 0.5 * Math.cos(6.2832 * h)
    out[1] = 0.5 + 0.5 * Math.cos(6.2832 * (h - 0.333))
    out[2] = 0.5 + 0.5 * Math.cos(6.2832 * (h - 0.667))
  }
  out[3] = 1
  return out
}

/** Polygon edges of a navmesh as line segments (xyz xyz) plus an area per segment. */
interface MeshLines {
  version: number
  lines: Float32Array
  areas: Uint8Array
  count: number
  links: Float32Array
  linkCount: number
}

const meshLines = new WeakMap<NavMeshRuntime, MeshLines>()
/** Walkable/blocked boundaries of a grid as XY segments. */
const gridLines = new WeakMap<GridRecord, { version: number; lines: Float32Array; count: number }>()

function linesOf(rt: NavMeshRuntime): MeshLines {
  const cached = meshLines.get(rt)
  if (cached && cached.version === rt.version) return cached
  const lines: number[] = []
  const areas: number[] = []
  const links: number[] = []
  for (const t of rt.tiles.values()) {
    if (!t.ref) continue
    const tile = rt.navMesh.getTileByRef(t.ref)
    const header = tile?.header()
    if (!tile || !header) continue
    for (let p = 0; p < header.polyCount(); p++) {
      const poly = tile.polys(p)
      const n = poly.vertCount()
      if (poly.getType() === 1) {
        // An off-mesh connection: its two vertices are the link's ends.
        const a = poly.verts(0) * 3
        const b = poly.verts(1) * 3
        links.push(tile.verts(a), tile.verts(a + 1), tile.verts(a + 2))
        links.push(tile.verts(b), tile.verts(b + 1), tile.verts(b + 2))
        continue
      }
      const area = poly.areaAndType() & 0x3f
      for (let i = 0; i < n; i++) {
        const a = poly.verts(i) * 3
        const b = poly.verts((i + 1) % n) * 3
        lines.push(tile.verts(a), tile.verts(a + 1) + 0.05, tile.verts(a + 2))
        lines.push(tile.verts(b), tile.verts(b + 1) + 0.05, tile.verts(b + 2))
        areas.push(area)
      }
    }
  }
  const out: MeshLines = {
    version: rt.version,
    lines: Float32Array.from(lines),
    areas: Uint8Array.from(areas),
    count: areas.length,
    links: Float32Array.from(links),
    linkCount: links.length / 6,
  }
  meshLines.set(rt, out)
  return out
}

function gridLinesOf(g: GridRecord) {
  const cached = gridLines.get(g)
  if (cached && cached.version === g.version) return cached
  const grid = g.grid!
  const w = grid.width
  const h = grid.height
  const lines: number[] = []
  const open = (x: number, y: number) => grid.get(x, y) > 0
  // Edges between a walkable cell and a blocked one (or the grid's edge).
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!open(x, y)) continue
      if (!open(x - 1, y)) lines.push(x, y, x, y + 1)
      if (!open(x + 1, y)) lines.push(x + 1, y, x + 1, y + 1)
      if (!open(x, y - 1)) lines.push(x, y, x + 1, y)
      if (!open(x, y + 1)) lines.push(x, y + 1, x + 1, y + 1)
    }
  }
  const out = { version: g.version, lines: Float32Array.from(lines), count: lines.length / 4 }
  gridLines.set(g, out)
  return out
}

const color = new Float32Array(4)
const LINK = new Float32Array([1, 0.75, 0.2, 1])
const GRID = new Float32Array([0.2, 0.85, 0.75, 1])
const PATH = new Float32Array([1, 0.95, 0.3, 1])
const UNREACHABLE = new Float32Array([1, 0.35, 0.3, 1])
const BLOCKED = new Float32Array([1, 0.6, 0.1, 1])
const SLOT_FREE = new Float32Array([0.55, 0.55, 0.6, 1])
const SLOT_TAKEN = new Float32Array([1, 0.6, 0.1, 1])
const a = new Float64Array(3)
const b = new Float64Array(3)
const mid = new Float64Array(3)

/** Budget of segments per frame: past it the overlay is unreadable anyway. */
const MAX_SEGMENTS = 60_000

export const navOverlay = defineOverlay({
  name: 'navmesh',
  description:
    'Navigation: navmesh polygon edges colored by area, off-mesh links as arcs, NavGrid walkable-area outlines, every NavAgent’s path (yellow; red when unreachable; amber, as far as the gate, while blocked at one), and slots at shut gates (0114: crosses, amber when claimed).',
  draw(world, g: GizmoStore, passes) {
    const nav = world.tryResource(Nav)
    if (!nav) return
    let budget = MAX_SEGMENTS
    for (const rt of nav.meshes.values()) {
      if (!passes(rt.entity)) continue
      const m = linesOf(rt)
      const l = m.lines
      for (let i = 0; i < m.count && budget > 0; i++, budget--) {
        const o = i * 6
        a[0] = l[o]!
        a[1] = l[o + 1]!
        a[2] = l[o + 2]!
        b[0] = l[o + 3]!
        b[1] = l[o + 4]!
        b[2] = l[o + 5]!
        g.line(a, b, areaColor(m.areas[i]!, color))
      }
      for (let i = 0; i < m.linkCount; i++) {
        const o = i * 6
        a[0] = m.links[o]!
        a[1] = m.links[o + 1]!
        a[2] = m.links[o + 2]!
        b[0] = m.links[o + 3]!
        b[1] = m.links[o + 4]!
        b[2] = m.links[o + 5]!
        mid[0] = (a[0] + b[0]) / 2
        mid[1] = Math.max(a[1], b[1]) + 0.5
        mid[2] = (a[2] + b[2]) / 2
        g.line(a, mid, LINK)
        g.line(mid, b, LINK)
      }
      // Slots at gates agents breach (0114): a small cross each.
      for (const set of rt.slots.values()) {
        for (let i = 0; i < set.count; i++) {
          const col = set.owner[i]! >= 0 ? SLOT_TAKEN : SLOT_FREE
          const r = set.radius * 0.5
          a[1] = b[1] = set.y[i]! + 0.05
          a[0] = set.x[i]! - r
          a[2] = set.z[i]!
          b[0] = set.x[i]! + r
          b[2] = set.z[i]!
          g.line(a, b, col)
          a[0] = b[0] = set.x[i]!
          a[2] = set.z[i]! - r
          b[2] = set.z[i]! + r
          g.line(a, b, col)
        }
      }
    }
    for (const rec of nav.grids.values()) {
      if (!rec.grid || !passes(rec.entity)) continue
      const gl = gridLinesOf(rec)
      const l = gl.lines
      for (let i = 0; i < gl.count && budget > 0; i++, budget--) {
        const o = i * 4
        a[0] = rec.ox + l[o]! * rec.csx
        a[1] = rec.oy + l[o + 1]! * rec.csy
        a[2] = rec.z
        b[0] = rec.ox + l[o + 2]! * rec.csx
        b[1] = rec.oy + l[o + 3]! * rec.csy
        b[2] = rec.z
        g.line(a, b, GRID)
      }
    }
    for (const rec of nav.agents.values()) {
      if (rec.count < 2 || !passes(rec.entity) || !world.isAlive(rec.entity)) continue
      if (!world.has(rec.entity, GlobalTransform)) continue
      const m = world.get(rec.entity, GlobalTransform).matrix
      const c = rec.corners
      const col = rec.status === BLOCKED_STATUS ? BLOCKED : rec.reachable ? PATH : UNREACHABLE
      a[0] = m[3]!
      a[1] = m[7]! + (rec.kind === 'mesh' ? 0.1 : 0)
      a[2] = m[11]!
      // Blocked at a gate (0114): as far as the gate.
      const end = rec.status === BLOCKED_STATUS ? Math.min(rec.count, rec.legCount + 1) : rec.count
      for (let i = Math.max(1, rec.kind === 'grid' ? rec.next : 1); i < end; i++) {
        b[0] = c[i * 3]!
        b[1] = c[i * 3 + 1]! + (rec.kind === 'mesh' ? 0.1 : 0)
        b[2] = c[i * 3 + 2]!
        g.line(a, b, col)
        a[0] = b[0]
        a[1] = b[1]
        a[2] = b[2]
      }
    }
  },
})
