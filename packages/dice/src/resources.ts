import type { AssetRef, World } from '@aethervtt/shard-core'
import { GpuAssetsResource, MaterialAsset, Materials, Meshes } from '@aethervtt/shard-render'
import { Texture, Textures } from '@aethervtt/shard-texture'
import type { DieKind } from './builtins'
import type { DieGeometry } from './definition'
import type { FaceLayoutValue } from './layout'
import { type BakeMarksOptions, bakeMarks, type MarkAtlas } from './marks'
import { type DiceFamily, findDiceFamily } from './material'
import { dieMesh } from './mesh'
import { type DiceSkinValue, skinVariant } from './skin'

// GPU resources of the dice on the table (0054): a mesh, a mark atlas and materials per
// (definition, skin, kind), reference-counted and released 8 s after their last use. Nothing here
// keeps a timer: the table asks for a frame when the next release is due.

export const RELEASE_AFTER_MS = 8000

/** Which material a die draws with. */
export interface DiceLookKey {
  /**
   * Premultiplied: dropped dice, fading dice, see-through families (but for the large-pool tier,
   * which draws those opaque so they batch).
   */
  blended: boolean
  dropped: boolean
}

export interface DiceResourceEntry {
  key: string
  geometry: DieGeometry
  kind: DieKind
  family: DiceFamily
  refs: number
  releaseAt: number
  mesh: AssetRef<'Mesh'>
  atlas: MarkAtlas
  texture: AssetRef<'Texture'>
  params: Record<string, unknown>
  materials: Map<string, AssetRef<'Material'>>
}

const lookKey = (l: DiceLookKey) => `${l.blended ? 'b' : 'o'}${l.dropped ? 'd' : ''}`

export class DiceResources {
  private readonly entries = new Map<string, DiceResourceEntry>()
  private readonly world: World
  /** The earliest release due (Infinity when none): checked every frame, so kept, not searched. */
  private due = Number.POSITIVE_INFINITY

  constructor(world: World) {
    this.world = world
  }

  /**
   * The resources for one kind of die in one skin, made on first use. Each acquire needs a
   * release. Throws `dice/unknown-family` for a skin whose family isn't defined.
   */
  acquire(
    geometry: DieGeometry,
    skinKey: string,
    skin: DiceSkinValue,
    kind: DieKind,
    layouts: (ref: AssetRef) => FaceLayoutValue | undefined,
    bake: BakeMarksOptions,
  ): DiceResourceEntry {
    const key = `${geometry.hash.toString(16)}|${skinKey}|${kind}`
    let entry = this.entries.get(key)
    if (!entry) {
      const family = findDiceFamily(skin.family)
      if (!family) throw new Error(`unknown family ${skin.family}`)
      const variant = skinVariant(skin, kind, geometry.definition.id, layouts)
      const atlas = bakeMarks(geometry, variant.layout, bake)
      const texture = this.world.resource(Textures).add(
        Texture.create({
          width: atlas.width,
          height: atlas.height,
          format: 'rgba8unorm',
          usage: 'data',
          mips: [atlas.pixels],
          cpu: true,
        }),
        `dice:marks/${geometry.definition.id}`,
      ) as AssetRef<'Texture'>
      const mesh = this.world
        .resource(Meshes)
        .add(
          dieMesh(geometry, variant.bevel),
          `dice:mesh/${geometry.definition.id}`,
        ) as AssetRef<'Mesh'>
      entry = {
        key,
        geometry,
        kind,
        family,
        refs: 0,
        releaseAt: Number.POSITIVE_INFINITY,
        mesh,
        atlas,
        texture,
        params: variant.params,
        materials: new Map(),
      }
      this.entries.set(key, entry)
    }
    entry.refs++
    entry.releaseAt = Number.POSITIVE_INFINITY
    return entry
  }

  /** The entry's material for a look, made on first use. */
  material(entry: DiceResourceEntry, look: DiceLookKey): AssetRef<'Material'> {
    const k = lookKey(look)
    const existing = entry.materials.get(k)
    if (existing) return existing
    const family = entry.family
    const schema = family.type.schema
    const params: Record<string, unknown> = {}
    for (const [name, v] of Object.entries(entry.params))
      if (name in schema.fields) params[name] = v
    const value = schema.deserialize(params) as Record<string, unknown>
    value.marks = entry.texture
    value.dropped = look.dropped ? 1 : 0
    value.fade = 1
    value.result = 0
    if (look.blended && !family.type.blend) value.alphaMode = 'premultiplied'
    const ref = this.world
      .resource(Materials)
      .add(
        new MaterialAsset(value, family.type),
        `dice:material/${entry.key}/${k}`,
      ) as AssetRef<'Material'>
    entry.materials.set(k, ref)
    return ref
  }

  /** Whether dice of this entry need blending in their normal look (glass, see-through resin). */
  blendedByNature(entry: DiceResourceEntry): boolean {
    return this.fixedBlend(entry) || (entry.family.translucent?.(entry.params) ?? false)
  }

  /** Whether the family's type fixes a blend: its dice blend in every tier, large pools too. */
  fixedBlend(entry: DiceResourceEntry): boolean {
    const blend = entry.family.type.blend
    return blend === 'alpha' || blend === 'premultiplied' || blend === 'additive'
  }

  /** Sets a field on every material of these entries (result, its time, fade). */
  setAll(
    entries: Iterable<DiceResourceEntry>,
    field: 'result' | 'resultTime' | 'fade',
    value: number,
  ): void {
    const materials = this.world.resource(Materials)
    for (const entry of entries) {
      for (const ref of entry.materials.values()) {
        const m = materials.get(ref)
        if (m && m.value[field] !== value) m.set({ [field]: value })
      }
    }
  }

  release(entry: DiceResourceEntry, now: number): void {
    entry.refs = Math.max(0, entry.refs - 1)
    if (entry.refs === 0) {
      entry.releaseAt = now + RELEASE_AFTER_MS
      this.due = Math.min(this.due, entry.releaseAt)
    }
  }

  /** The earliest release due, or Infinity. */
  nextRelease(): number {
    return this.due
  }

  /** Frees entries unused for 8 s. Returns how many. */
  sweep(now: number): number {
    let n = 0
    this.due = Number.POSITIVE_INFINITY
    for (const entry of [...this.entries.values()]) {
      if (entry.refs > 0) continue
      if (entry.releaseAt > now) {
        this.due = Math.min(this.due, entry.releaseAt)
        continue
      }
      this.free(entry)
      n++
    }
    return n
  }

  private free(entry: DiceResourceEntry): void {
    const world = this.world
    const gpu = world.tryResource(GpuAssetsResource)
    const meshes = world.resource(Meshes)
    const materials = world.resource(Materials)
    const textures = world.resource(Textures)
    const mesh = meshes.get(entry.mesh)
    if (mesh) gpu?.releaseMesh(mesh)
    meshes.delete(entry.mesh.guid!)
    for (const ref of entry.materials.values()) {
      const m = materials.get(ref)
      if (m) gpu?.releaseMaterial(m)
      materials.delete(ref.guid!)
    }
    const texture = textures.get(entry.texture)
    if (texture) gpu?.releaseTexture(texture)
    textures.delete(entry.texture.guid!)
    this.entries.delete(entry.key)
  }

  /** Frees everything, used or not (teardown). */
  dispose(): void {
    for (const entry of [...this.entries.values()]) this.free(entry)
    this.due = Number.POSITIVE_INFINITY
  }

  stats(): { entries: number; used: number; meshes: number; atlases: number; materials: number } {
    let used = 0
    let materials = 0
    for (const e of this.entries.values()) {
      if (e.refs > 0) used++
      materials += e.materials.size
    }
    return {
      entries: this.entries.size,
      used,
      meshes: this.entries.size,
      atlases: this.entries.size,
      materials,
    }
  }

  describe(): {
    key: string
    die: string
    kind: DieKind
    family: string
    refs: number
    releaseInMs: number | null
    materials: string[]
    atlas: [number, number]
  }[] {
    return [...this.entries.values()].map((e) => ({
      key: e.key,
      die: e.geometry.definition.id,
      kind: e.kind,
      family: e.family.name,
      refs: e.refs,
      releaseInMs: e.refs > 0 ? null : e.releaseAt,
      materials: [...e.materials.keys()],
      atlas: [e.atlas.width, e.atlas.height],
    }))
  }
}
