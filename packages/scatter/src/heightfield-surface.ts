import type { Entity, Query, World } from '@aethervtt/shard-core'
import type { HeightfieldRuntime } from '@aethervtt/shard-terrain'
import { mainNoise, pageHeight } from '@aethervtt/shard-terrain'
import { placeInGrid } from '@aethervtt/shard-transform'
import { type HeightIndex, MeshSurface } from './mesh-surface'
import type { SurfaceChunk } from './surface'

/**
 * A heightfield's ground for scatter (0045 on 0071): heights and face normals from its leaf pages,
 * the triangles its colliders and mesh have, so a prop stands on what a character stands on. Leaf
 * pages come from the CPU cache, or are baked on the spot (the same bytes), so placement never
 * depends on what has streamed in.
 */
export class HeightfieldIndex {
  readonly rt: HeightfieldRuntime
  readonly minX = 0
  readonly minZ = 0
  readonly maxX: number
  readonly maxZ: number
  readonly minY: number
  readonly maxY: number

  constructor(rt: HeightfieldRuntime) {
    this.rt = rt
    this.maxX = rt.layout!.sizeX
    this.maxZ = rt.layout!.sizeZ
    this.minY = rt.lo
    this.maxY = rt.hi
  }

  /** The ground under (x, z): writes [height, nx, ny, nz] (up-facing) and returns true on the terrain. */
  heightAt(x: number, z: number, out: Float64Array): boolean {
    const rt = this.rt
    const l = rt.layout!
    if (!(x >= 0 && z >= 0 && x <= l.sizeX && z <= l.sizeZ)) return false
    const size = l.leafSize
    const px = Math.min(l.leavesX - 1, Math.floor(x / size))
    const pz = Math.min(l.leavesZ - 1, Math.floor(z / size))
    const page = rt.pages!.leafNow(mainNoise(), rt.stack!, px, pz)
    const e = 0.05
    const h = pageHeight(rt, page, x, z)
    // The face normal from heights a little either side (within the same triangle in most cases).
    const hx = pageHeight(rt, page, Math.min(x + e, (px + 1) * size), z)
    const hz = pageHeight(rt, page, x, Math.min(z + e, (pz + 1) * size))
    const dx = (hx - h) / Math.max(1e-6, Math.min(x + e, (px + 1) * size) - x)
    const dz = (hz - h) / Math.max(1e-6, Math.min(z + e, (pz + 1) * size) - z)
    const len = Math.sqrt(dx * dx + 1 + dz * dz)
    out[0] = h
    out[1] = -dx / len
    out[2] = 1 / len
    out[3] = -dz / len
    return true
  }
}

/**
 * A heightfield terrain as a scatter surface (`Terrain.scatter`): the mesh surface's square
 * lattice in the terrain's frame (its corner at 0, +Y up), heights from its pages, chunk roots as
 * grid children of the terrain.
 */
export class HeightfieldSurface extends MeshSurface {
  override readonly kind = 'heightfield'
  readonly rt: HeightfieldRuntime

  constructor(world: World, rt: HeightfieldRuntime, cameras: Query) {
    super(world, rt.entity, cameras)
    this.rt = rt
    this.scale = 1
  }

  /** Takes the terrain's pages (again after a rebake). */
  setTerrain(): void {
    this.index = new HeightfieldIndex(this.rt) as unknown as HeightIndex
  }

  override placeChunkRoot(world: World, root: Entity, chunk: SurfaceChunk): void {
    placeInGrid(world, root, this.entity, chunk.center)
  }
}
