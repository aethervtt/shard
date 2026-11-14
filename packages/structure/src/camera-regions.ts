import { type AssetRef, ChildOf, Derived, type Entity, type World } from '@aethervtt/shard-core'
import { Mesh } from '@aethervtt/shard-mesh'
import {
  Cutaway,
  GpuAssetsResource,
  Mesh3d,
  Meshes,
  MeshMaterial,
  NotShadowCaster,
  ShadowWhenHidden,
} from '@aethervtt/shard-render'
import { Transform } from '@aethervtt/shard-transform'
import { StructureCameraRegion } from './components'
import { chunkKey, chunkX, chunkZ } from './geometry'
import type { ProxyHost } from './shadow-proxies'

// Region meshes for camera views (0073): a street of houses is thousands of chunk meshes, one batch
// each, and each costs its slot every frame. With `StructureSettings.cameraRegions`, every region
// of the shadow-proxy grid (32 m) draws one mesh per (group, material): the same triangles, in the
// same world space, as its chunk meshes, which stop drawing (no Mesh3d) but stay the unit of
// rebuild and keep their occluders. A chunk rebuild rebuilds its region in the same compile.

const GROUP_STRIDE = 4294967296

interface RegionMesh {
  entity: Entity
  mesh: Mesh
  ref: AssetRef<'Mesh'>
}

export interface RegionHost extends ProxyHost {
  /** Region size in metres (the shadow proxies'). */
  regionSize(): number
}

export class CameraRegions {
  on = false
  readonly dirty = new Set<number>()
  /** Region key (group slot × stride + region key) → material key → its mesh. */
  readonly records = new Map<number, Map<string, RegionMesh>>()
  rebuilt = 0
  lastRebuilt = 0

  private span(host: RegionHost): number {
    return Math.max(1, Math.round(host.regionSize() / host.chunkSize))
  }

  private regionOf(host: RegionHost, key: number): number {
    const k = this.span(host)
    const plain = key % GROUP_STRIDE
    const slot = Math.floor(key / GROUP_STRIDE)
    return (
      slot * GROUP_STRIDE + chunkKey(Math.floor(chunkX(plain) / k), Math.floor(chunkZ(plain) / k))
    )
  }

  /** Marks the region of a rebuilt (group, chunk) key. */
  mark(host: RegionHost, key: number): void {
    if (this.on) this.dirty.add(this.regionOf(host, key))
  }

  /** Turns regions on or off: chunk meshes draw for themselves again when off. */
  reset(host: RegionHost, on: boolean): void {
    const world = host.world
    for (const recs of this.records.values()) for (const r of recs.values()) drop(world, r)
    this.records.clear()
    this.dirty.clear()
    this.on = on
    for (const [key, chunk] of host.chunks) {
      for (const cm of chunk.meshes.values()) drawChunk(world, cm.entity, cm.ref, !on)
      if (on) this.dirty.add(this.regionOf(host, key))
    }
  }

  /** Rebuilds every dirty region, after the compile's chunks and shadow proxies. */
  update(host: RegionHost): void {
    this.lastRebuilt = 0
    if (!this.on || this.dirty.size === 0) return
    for (const region of this.dirty) this.rebuild(host, region)
    this.lastRebuilt = this.dirty.size
    this.rebuilt += this.dirty.size
    this.dirty.clear()
  }

  private rebuild(host: RegionHost, region: number): void {
    const world = host.world
    const k = this.span(host)
    const slot = Math.floor(region / GROUP_STRIDE)
    const plain = region % GROUP_STRIDE
    const rx = chunkX(plain)
    const rz = chunkZ(plain)
    const group = host.groups[slot]!
    // The region's chunk meshes per material, in chunk order.
    const byMaterial = new Map<
      string,
      { meshes: Mesh[]; casts: boolean; hidden: boolean; cutaway: boolean }
    >()
    for (let cx = rx * k; cx < rx * k + k; cx++) {
      for (let cz = rz * k; cz < rz * k + k; cz++) {
        const chunk = host.chunks.get(slot * GROUP_STRIDE + chunkKey(cx, cz))
        if (!chunk) continue
        for (const [key, cm] of chunk.meshes) {
          if (!world.isAlive(cm.entity)) continue
          drawChunk(world, cm.entity, cm.ref, false)
          let m = byMaterial.get(key)
          if (!m) {
            m = { meshes: [], casts: false, hidden: false, cutaway: false }
            byMaterial.set(key, m)
          }
          m.meshes.push(cm.mesh)
          // Shadow proxies cast for merged materials; the rest cast as themselves (0116).
          if (!world.has(cm.entity, NotShadowCaster)) m.casts = true
          if (world.has(cm.entity, ShadowWhenHidden)) m.hidden = true
          if (world.has(cm.entity, Cutaway)) m.cutaway = true
        }
      }
    }
    let recs = this.records.get(region)
    if (!recs) {
      recs = new Map()
      this.records.set(region, recs)
    }
    for (const [key, r] of recs) {
      if (byMaterial.has(key)) continue
      drop(world, r)
      recs.delete(key)
    }
    for (const [key, m] of byMaterial) {
      const data = merge(m.meshes)
      let r = recs.get(key)
      if (r && world.isAlive(r.entity)) {
        r.mesh.update(data)
      } else {
        const mesh = Mesh.create(data)
        mesh.arena = 'structure'
        const ref = world
          .resource(Meshes)
          .add(
            mesh,
            `structure:region/${group}/${rx},${rz}/${key || 'default'}`,
          ) as AssetRef<'Mesh'>
        const entity = world.spawn(
          [Mesh3d, { mesh: ref }],
          [MeshMaterial, { material: host.materialRef(materialKey(key)) }],
          [StructureCameraRegion, { group, x: rx, z: rz }],
          [ChildOf, { parent: group }],
          Transform,
          Derived,
        )
        r = { entity, mesh, ref }
        recs.set(key, r)
      }
      setTag(world, r.entity, NotShadowCaster, !m.casts)
      setTag(world, r.entity, ShadowWhenHidden, m.hidden)
      setTag(world, r.entity, Cutaway, m.cutaway)
    }
    if (recs.size === 0) this.records.delete(region)
  }
}

/** Chunk meshes concatenated: positions, normals, uvs and tangents, as compile builds them. */
function merge(meshes: Mesh[]) {
  let vertices = 0
  let indices = 0
  for (const m of meshes) {
    vertices += m.vertexCount
    indices += m.indices?.length ?? 0
  }
  const positions = new Float32Array(vertices * 3)
  const normals = new Float32Array(vertices * 3)
  const uvs = new Float32Array(vertices * 2)
  const tangents = new Float32Array(vertices * 4)
  const index = vertices < 65536 ? new Uint16Array(indices) : new Uint32Array(indices)
  let v = 0
  let i = 0
  for (const m of meshes) {
    const n = m.vertexCount
    positions.set(m.positions.subarray(0, n * 3), v * 3)
    if (m.normals) normals.set(m.normals.subarray(0, n * 3), v * 3)
    if (m.uvs) uvs.set(m.uvs.subarray(0, n * 2), v * 2)
    if (m.tangents) tangents.set(m.tangents.subarray(0, n * 4), v * 4)
    const src = m.indices!
    for (let t = 0; t < src.length; t++) index[i + t] = src[t]! + v
    v += n
    i += src.length
  }
  return { positions, normals, uvs, tangents, indices: index }
}

/** Whether a chunk mesh draws for itself (it doesn't while its region draws it). */
function drawChunk(world: World, entity: Entity, ref: AssetRef<'Mesh'>, on: boolean): void {
  if (!world.isAlive(entity) || world.has(entity, Mesh3d) === on) return
  if (on) world.add(entity, Mesh3d, { mesh: ref })
  else world.remove(entity, Mesh3d)
}

function setTag(world: World, entity: Entity, tag: Parameters<World['has']>[1], on: boolean): void {
  if (world.has(entity, tag) === on) return
  if (on) world.add(entity, tag as never, {} as never)
  else world.remove(entity, tag)
}

function drop(world: World, r: RegionMesh): void {
  if (world.isAlive(r.entity)) world.despawn(r.entity)
  world.tryResource(GpuAssetsResource)?.releaseMesh(r.mesh)
  world.resource(Meshes).delete(r.ref.guid!)
}

/** A chunk mesh key's material: wall pieces built apart (cutaway walls) carry a prefix. */
function materialKey(key: string): string {
  return key.startsWith('#wall/') ? key.slice('#wall/'.length) : key
}
