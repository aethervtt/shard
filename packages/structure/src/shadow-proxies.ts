import { type AssetRef, ChildOf, Derived, type Entity, type World } from '@aethervtt/shard-core'
import { Mesh } from '@aethervtt/shard-mesh'
import {
  GpuAssetsResource,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
  NotShadowCaster,
  ShadowWhenHidden,
  STANDARD_TYPE,
  Visibility,
} from '@aethervtt/shard-render'
import { Transform } from '@aethervtt/shard-transform'
import { StructureShadowProxy } from './components'
import { chunkKey, chunkX, chunkZ } from './geometry'

// Shadow proxies (0116): a shadow pass over a town draws one merged, depth-only mesh per 32 m
// region and group instead of a mesh per (chunk, material). A proxy holds the same triangles, in the
// same world space, as the chunk meshes it stands for, so the shadow maps are bit-identical; those
// chunk meshes stop casting (NotShadowCaster). Only plain standard, opaque,
// single-sided materials merge: masked ones discard, double-sided ones cull differently, and custom
// types may move vertices. Those keep casting from their chunks.

/** Bits of a (group, chunk) key above the plain chunk key (StructureState's GROUP_STRIDE). */
const GROUP_STRIDE = 4294967296

/** What the proxies need of StructureState (kept narrow so compile.ts owns the state). */
export interface ProxyHost {
  readonly world: World
  readonly groups: Entity[]
  readonly chunks: Map<
    number,
    {
      group: Entity
      x: number
      z: number
      meshes: Map<string, { entity: Entity; mesh: Mesh }>
    }
  >
  chunkSize: number
  materialRef(key: string): AssetRef<'Material'>
  groupSlot(group: Entity): number
}

interface ProxyRecord {
  entity: Entity
  mesh: Mesh
  ref: AssetRef<'Mesh'>
}

export class ShadowProxies {
  /** Region size in meters; 0 turns proxies off. */
  size = 0
  /** Region keys (group slot × GROUP_STRIDE + region key) whose geometry changed. */
  readonly dirty = new Set<number>()
  readonly records = new Map<number, ProxyRecord>()
  /** Proxies rebuilt so far, and by the last compile (describe). */
  rebuilt = 0
  lastRebuilt = 0
  private readonly pending: number[] = []
  private material: AssetRef<'Material'> | undefined
  private readonly mergeable = new Map<string, boolean>()
  private readonly opaques = new Map<string, boolean>()

  /** Chunks per region side. */
  span(host: ProxyHost): number {
    return Math.max(1, Math.round(this.size / host.chunkSize))
  }

  /** The region holding (group, chunk) key `key`. */
  regionOf(host: ProxyHost, key: number): number {
    const k = this.span(host)
    const plain = key % GROUP_STRIDE
    const slot = Math.floor(key / GROUP_STRIDE)
    return (
      slot * GROUP_STRIDE + chunkKey(Math.floor(chunkX(plain) / k), Math.floor(chunkZ(plain) / k))
    )
  }

  /** Marks the region of a rebuilt (group, chunk) key. */
  mark(host: ProxyHost, key: number): void {
    if (this.size > 0) this.dirty.add(this.regionOf(host, key))
  }

  /** Drops every proxy (settings changed, chunks reset); chunks cast for themselves again. */
  reset(host: ProxyHost): void {
    for (const rec of this.records.values()) this.drop(host.world, rec)
    this.records.clear()
    this.dirty.clear()
    this.mergeable.clear()
    this.opaques.clear()
    for (const chunk of host.chunks.values())
      for (const cm of chunk.meshes.values()) setCaster(host.world, cm.entity, true)
    if (this.size > 0)
      for (const key of host.chunks.keys()) this.dirty.add(this.regionOf(host, key))
  }

  /**
   * Rebuilds every dirty region, in the compile that rebuilt its chunks: a proxy is never stale, so
   * its chunks never need to cast in its place.
   */
  update(host: ProxyHost): void {
    this.lastRebuilt = 0
    if (this.dirty.size === 0) return
    // A region whose material is still loading marks itself again: next compile.
    const regions = this.pending
    regions.length = 0
    for (const region of this.dirty) regions.push(region)
    this.dirty.clear()
    for (let i = 0; i < regions.length; i++) this.rebuild(host, regions[i]!)
    this.lastRebuilt = regions.length
    this.rebuilt += regions.length
  }

  /** Whether a material is opaque (its walls occlude, 0116). Unloaded: not yet. */
  opaque(host: ProxyHost, key: string): boolean {
    const known = this.opaques.get(key)
    if (known !== undefined) return known
    const material = host.world.resource(Materials).get(host.materialRef(key))
    if (!material) return false
    const ok = material.type.blendOf(material.value) === 'opaque'
    this.opaques.set(key, ok)
    return ok
  }

  /** Whether chunk meshes of this material merge into proxies. Unloaded: not yet. */
  private merges(host: ProxyHost, key: string): boolean {
    const known = this.mergeable.get(key)
    if (known !== undefined) return known
    const material = host.world.resource(Materials).get(host.materialRef(key))
    if (!material) return false
    const ok =
      material.type === STANDARD_TYPE &&
      material.type.blendOf(material.value) === 'opaque' &&
      !material.value.doubleSided
    this.mergeable.set(key, ok)
    return ok
  }

  private rebuild(host: ProxyHost, region: number): void {
    const world = host.world
    const k = this.span(host)
    const slot = Math.floor(region / GROUP_STRIDE)
    const plain = region % GROUP_STRIDE
    const rx = chunkX(plain)
    const rz = chunkZ(plain)
    const group = host.groups[slot]!
    // The region's chunk meshes that merge, and whether any of them casts while hidden.
    let vertices = 0
    let indices = 0
    let shadowWhenHidden = false
    let waiting = false
    for (let cx = rx * k; cx < rx * k + k; cx++) {
      for (let cz = rz * k; cz < rz * k + k; cz++) {
        const chunk = host.chunks.get(slot * GROUP_STRIDE + chunkKey(cx, cz))
        if (!chunk) continue
        for (const [key, cm] of chunk.meshes) {
          if (!world.isAlive(cm.entity)) continue
          const merge = this.merges(host, materialKey(key))
          if (!merge && !world.resource(Materials).get(host.materialRef(materialKey(key))))
            waiting = true
          setCaster(world, cm.entity, !merge)
          if (!merge) continue
          vertices += cm.mesh.vertexCount
          indices += cm.mesh.indices?.length ?? 0
          if (world.has(cm.entity, ShadowWhenHidden)) shadowWhenHidden = true
        }
      }
    }
    // A material still loading: look again next compile.
    if (waiting) this.dirty.add(region)
    let rec = this.records.get(region)
    if (vertices === 0) {
      if (rec) {
        this.drop(world, rec)
        this.records.delete(region)
      }
      return
    }
    const positions = new Float32Array(vertices * 3)
    const index = vertices < 65536 ? new Uint16Array(indices) : new Uint32Array(indices)
    let v = 0
    let i = 0
    for (let cx = rx * k; cx < rx * k + k; cx++) {
      for (let cz = rz * k; cz < rz * k + k; cz++) {
        const chunk = host.chunks.get(slot * GROUP_STRIDE + chunkKey(cx, cz))
        if (!chunk) continue
        for (const [key, cm] of chunk.meshes) {
          if (!world.isAlive(cm.entity) || !this.merges(host, materialKey(key))) continue
          const m = cm.mesh
          positions.set(m.positions.subarray(0, m.vertexCount * 3), v * 3)
          const src = m.indices!
          for (let t = 0; t < src.length; t++) index[i + t] = src[t]! + v
          v += m.vertexCount
          i += src.length
        }
      }
    }
    const data = { positions, indices: index }
    if (rec && world.isAlive(rec.entity)) {
      rec.mesh.update(data)
    } else {
      if (rec) this.drop(world, rec)
      const mesh = Mesh.create(data)
      mesh.arena = 'structure'
      const ref = world
        .resource(Meshes)
        .add(mesh, `structure:shadow/${group}/${rx},${rz}`) as AssetRef<'Mesh'>
      const entity = world.spawn(
        [Mesh3d, { mesh: ref }],
        [MeshMaterial, { material: this.proxyMaterial(world) }],
        [Visibility, { mode: 'shadow-only' }],
        [StructureShadowProxy, { group, x: rx, z: rz }],
        [ChildOf, { parent: group }],
        Transform,
        Derived,
      )
      rec = { entity, mesh, ref }
      this.records.set(region, rec)
    }
    if (world.has(rec.entity, ShadowWhenHidden) !== shadowWhenHidden) {
      if (shadowWhenHidden) world.add(rec.entity, ShadowWhenHidden)
      else world.remove(rec.entity, ShadowWhenHidden)
    }
  }

  private drop(world: World, rec: ProxyRecord): void {
    if (world.isAlive(rec.entity)) world.despawn(rec.entity)
    world.tryResource(GpuAssetsResource)?.releaseMesh(rec.mesh)
    world.resource(Meshes).delete(rec.ref.guid!)
  }

  /** One shared opaque material for every proxy: shadow passes bind it once. */
  private proxyMaterial(world: World): AssetRef<'Material'> {
    if (!this.material)
      this.material = world
        .resource(Materials)
        .add(new MaterialAsset({}), 'structure:shadow-proxy') as AssetRef<'Material'>
    return this.material
  }
}

/** A chunk mesh key's material: wall pieces built apart (cutaway walls) carry a prefix. */
function materialKey(key: string): string {
  return key.startsWith('#wall/') ? key.slice('#wall/'.length) : key
}

/** Whether a chunk mesh casts for itself (it doesn't while a proxy stands for it). */
function setCaster(world: World, entity: Entity, on: boolean): void {
  if (!world.isAlive(entity) || world.has(entity, NotShadowCaster) === !on) return
  if (on) world.remove(entity, NotShadowCaster)
  else world.add(entity, NotShadowCaster)
}
