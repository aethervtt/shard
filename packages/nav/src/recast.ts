import { ShardError } from '@shard/core'
import type * as RecastModule from 'recast-navigation'
import type { TriangleSoup } from './geometry'

export type Recast = typeof RecastModule

let module: Promise<Recast> | undefined

/** Loads and initializes Recast and Detour (WASM) once per process. */
export function loadRecast(): Promise<Recast> {
  module ??= (async () => {
    const R = (await import('recast-navigation')) as Recast
    await R.init()
    return R
  })()
  return module
}

/** What a NavMesh bakes with, as its component fields. */
export interface BakeSettings {
  agentRadius: number
  agentHeight: number
  maxClimb: number
  maxSlope: number
  cellSize: number
  cellHeight: number
  tileSize: number
}

/** Recast's walkable area code; Detour sees it as area 0. */
const WALKABLE = 63

/** Poly flags for an area: one bit per area 0–14, so filters can exclude areas exactly. */
export function areaFlags(area: number): number {
  return 1 << (area < 15 ? area : 15)
}

export interface OffMeshLinkParams {
  start: [number, number, number]
  end: [number, number, number]
  radius: number
  bidirectional: boolean
  area: number
}

/** Voxel counts Recast wants, from world-unit settings. */
export function voxelSettings(s: BakeSettings) {
  const walkableRadius = Math.ceil(s.agentRadius / s.cellSize)
  return {
    walkableRadius,
    walkableHeight: Math.max(3, Math.ceil(s.agentHeight / s.cellHeight)),
    walkableClimb: Math.floor(s.maxClimb / s.cellHeight),
    borderSize: walkableRadius + 3,
    tileWorld: s.tileSize * s.cellSize,
  }
}

/** Reused typed buffers for one tile's triangles. */
const scratch = { verts: new Float32Array(0), tris: new Int32Array(0), areas: new Uint8Array(0) }

/**
 * Builds one navmesh tile with Recast: the triangles of `soup` listed in `triangles` (already
 * those overlapping the tile plus its border), rasterized with their area codes, filtered for
 * the agent, and turned into Detour tile data. Returns the tile's bytes, or null when nothing is
 * walkable in it. Throws `nav/bake-failed` when a Recast step fails.
 */
export function buildTile(
  R: Recast,
  s: BakeSettings,
  tx: number,
  ty: number,
  yMin: number,
  yMax: number,
  soup: TriangleSoup,
  triangles: Int32Array,
  count: number,
  links: readonly OffMeshLinkParams[],
): Uint8Array | null {
  const v = voxelSettings(s)
  const cs = s.cellSize
  const ch = s.cellHeight
  const border = v.borderSize
  const size = s.tileSize + border * 2
  const bmin: [number, number, number] = [
    tx * v.tileWorld - border * cs,
    yMin,
    ty * v.tileWorld - border * cs,
  ]
  const bmax: [number, number, number] = [
    (tx + 1) * v.tileWorld + border * cs,
    yMax,
    (ty + 1) * v.tileWorld + border * cs,
  ]
  if (count === 0) return null

  if (scratch.areas.length < count) {
    scratch.verts = new Float32Array(count * 9)
    scratch.tris = new Int32Array(count * 3)
    scratch.areas = new Uint8Array(count)
  }
  const p = soup.positions
  for (let i = 0; i < count; i++) {
    const t = triangles[i]!
    scratch.verts.set(p.subarray(t * 9, t * 9 + 9), i * 9)
    scratch.tris[i * 3] = i * 3
    scratch.tris[i * 3 + 1] = i * 3 + 1
    scratch.tris[i * 3 + 2] = i * 3 + 2
    scratch.areas[i] = soup.areas[t]!
  }

  const ctx = new R.RecastBuildContext(false)
  const verts = new R.VerticesArray()
  const tris = new R.TrianglesArray()
  const areas = new R.TriangleAreasArray()
  verts.copy(scratch.verts.subarray(0, count * 9))
  tris.copy(scratch.tris.subarray(0, count * 3))
  areas.resize(count)
  let hf: ReturnType<Recast['allocHeightfield']> | undefined
  let chf: ReturnType<Recast['allocCompactHeightfield']> | undefined
  let cset: ReturnType<Recast['allocContourSet']> | undefined
  let pmesh: ReturnType<Recast['allocPolyMesh']> | undefined
  let dmesh: ReturnType<Recast['allocPolyMeshDetail']> | undefined
  const fail = (step: string): never => {
    throw new ShardError('nav/bake-failed', `Recast failed to ${step} for tile (${tx}, ${ty})`, {
      hint: 'Check the NavMesh settings: cellSize and cellHeight must be positive, and tileSize small enough for its bounds.',
    })
  }
  try {
    hf = R.allocHeightfield()
    if (!R.createHeightfield(ctx, hf, size, size, bmin, bmax, cs, ch)) fail('create a heightfield')
    R.markWalkableTriangles(ctx, s.maxSlope, verts, count * 3, tris, count, areas)
    // Walkable triangles take their source's area code (area 0 stays Recast's walkable code).
    const view = areas.getHeapView()
    for (let i = 0; i < count; i++) {
      const a = scratch.areas[i]!
      if (a !== 0 && view[i] === WALKABLE) view[i] = a
    }
    if (!R.rasterizeTriangles(ctx, verts, count * 3, tris, areas, count, hf, v.walkableClimb))
      fail('rasterize triangles')
    R.filterLowHangingWalkableObstacles(ctx, v.walkableClimb, hf)
    R.filterLedgeSpans(ctx, v.walkableHeight, v.walkableClimb, hf)
    R.filterWalkableLowHeightSpans(ctx, v.walkableHeight, hf)
    chf = R.allocCompactHeightfield()
    if (!R.buildCompactHeightfield(ctx, v.walkableHeight, v.walkableClimb, hf, chf))
      fail('build the compact heightfield')
    R.freeHeightfield(hf)
    hf = undefined
    if (!R.erodeWalkableArea(ctx, v.walkableRadius, chf)) fail('erode the walkable area')
    if (!R.buildDistanceField(ctx, chf)) fail('build the distance field')
    if (!R.buildRegions(ctx, chf, border, 8 * 8, 20 * 20)) fail('build regions')
    cset = R.allocContourSet()
    const maxEdge = Math.ceil((s.agentRadius * 8) / cs) || 12
    if (!R.buildContours(ctx, chf, 1.3, maxEdge, cset, R.Recast.RC_CONTOUR_TESS_WALL_EDGES))
      fail('trace contours')
    pmesh = R.allocPolyMesh()
    if (!R.buildPolyMesh(ctx, cset, 6, pmesh)) fail('triangulate contours')
    dmesh = R.allocPolyMeshDetail()
    if (!R.buildPolyMeshDetail(ctx, pmesh, chf, cs * 6, ch * 1, dmesh))
      fail('build the detail mesh')
    const npolys = pmesh.npolys()
    if (npolys === 0) return null
    for (let i = 0; i < npolys; i++) {
      let area = pmesh.areas(i)
      if (area === WALKABLE) {
        area = 0
        pmesh.setAreas(i, 0)
      }
      pmesh.setFlags(i, areaFlags(area))
    }
    const params = new R.NavMeshCreateParams()
    params.setPolyMeshCreateParams(pmesh)
    params.setPolyMeshDetailCreateParams(dmesh)
    params.setWalkableHeight(v.walkableHeight * ch)
    params.setWalkableRadius(v.walkableRadius * cs)
    params.setWalkableClimb(v.walkableClimb * ch)
    params.setCellSize(cs)
    params.setCellHeight(ch)
    params.setBuildBvTree(true)
    if (links.length > 0) {
      params.setOffMeshConnections(
        links.map((l) => ({
          startPosition: { x: l.start[0], y: l.start[1], z: l.start[2] },
          endPosition: { x: l.end[0], y: l.end[1], z: l.end[2] },
          radius: l.radius,
          bidirectional: l.bidirectional,
          area: l.area,
          flags: areaFlags(l.area),
        })),
      )
    }
    params.setTileX(tx)
    params.setTileY(ty)
    const result = R.createNavMeshData(params)
    R.Raw.destroy(params.raw)
    if (!result.success) fail('create Detour tile data')
    const bytes = result.navMeshData.toTypedArray().slice()
    result.navMeshData.destroy()
    return bytes
  } finally {
    if (hf) R.freeHeightfield(hf)
    if (chf) R.freeCompactHeightfield(chf)
    if (cset) R.freeContourSet(cset)
    if (pmesh) R.freePolyMesh(pmesh)
    if (dmesh) R.freePolyMeshDetail(dmesh)
    verts.destroy()
    tris.destroy()
    areas.destroy()
    R.Raw.destroy(ctx.raw)
  }
}
