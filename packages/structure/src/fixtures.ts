import { type AssetRef, ChildOf, type Entity, type World } from '@aethervtt/shard-core'
import { cylinder, type Mesh, sphere } from '@aethervtt/shard-mesh'
import { createMirror, type Mirror } from '@aethervtt/shard-mirror'
import {
  GpuAssetsResource,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
} from '@aethervtt/shard-render'
import { Transform } from '@aethervtt/shard-transform'
import {
  type FloorDoc,
  LIMITS,
  type MaterialDoc,
  maxScene,
  type OpeningDoc,
  type PropDoc,
  type SceneDocs,
  type SceneGrid,
  shadowStress,
  type TokenDoc,
  type WallDoc,
} from '../fixtures/structure/index.mjs'
import { Floor, Opening, Wall } from './components'

export { LIMITS, maxScene, type SceneDocs, shadowStress }

/**
 * The fixed visual scale from Aether pixels to world units: 70 px (a cell) is 1.5 m. It never
 * depends on the grid's game distance ("5 ft per square").
 */
export const PX_TO_WORLD = 1.5 / 70

function linear(hex: string): [number, number, number, number] {
  const c = (i: number) => {
    const v = Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return [c(0), c(1), c(2), 1]
}

/** What one `sync` of every mirror did. */
export interface HostSyncCounts {
  spawned: number
  applied: number
  removed: number
  resized: number
}

/**
 * A reference host adapter for Aether-shaped scenes (the one Aether ships lives in Aether): each
 * document list is mirrored onto entities (0055), in world units through one fixed visual scale.
 * Tokens are a logical root with a flat disc as a visual child; token footprints and props are
 * sized in cells, so the grid's pixel size resizes them, and nothing else about the grid does.
 */
export class HostScene {
  readonly world: World
  readonly k: number
  readonly materials: Mirror<MaterialDoc>
  readonly walls: Mirror<WallDoc>
  readonly openings: Mirror<OpeningDoc>
  readonly floors: Mirror<FloorDoc>
  readonly props: Mirror<PropDoc>
  readonly tokens: Mirror<TokenDoc>
  /** Token root → its disc. */
  readonly discs = new Map<Entity, Entity>()
  grid: SceneGrid | undefined
  private readonly materialRefs = new Map<string, AssetRef<'Material'>>()
  private readonly propMeshes = new Map<string, AssetRef<'Mesh'>>()
  private readonly tokenDocs = new Map<Entity, TokenDoc>()
  private readonly propDocs = new Map<Entity, PropDoc>()
  private discMesh: AssetRef<'Mesh'> | undefined
  private tokenMaterial: AssetRef<'Material'> | undefined

  constructor(world: World, pxToWorld = PX_TO_WORLD) {
    this.world = world
    this.k = pxToWorld
    const k = pxToWorld
    const rev = (d: { rev: number }) => d.rev
    const id = (d: { id: string }) => d.id
    this.materials = createMirror<MaterialDoc>(world, {
      key: id,
      rev,
      spawn: (doc) => {
        const ref = world
          .resource(Materials)
          .add(new MaterialAsset({}), `host:material/${doc.id}`) as AssetRef<'Material'>
        this.materialRefs.set(doc.id, ref)
        // Materials aren't entities: a placeholder keeps the mirror's bookkeeping uniform.
        return world.spawn()
      },
      apply: (_e, doc) => {
        const ref = this.materialRefs.get(doc.id)!
        world
          .resource(Materials)
          .get(ref)
          ?.set({ baseColor: linear(doc.tint), roughness: doc.roughness })
      },
      despawn: (e, w, key) => {
        const ref = this.materialRefs.get(key)
        if (ref) {
          const material = w.resource(Materials).get(ref)
          if (material) w.tryResource(GpuAssetsResource)?.releaseMaterial(material)
          w.resource(Materials).delete(ref.guid!)
          this.materialRefs.delete(key)
        }
        w.despawn(e)
      },
    })
    this.walls = createMirror<WallDoc>(world, {
      key: id,
      rev,
      spawn: () => world.spawn(Wall),
      apply: (e, d) =>
        world.set(e, Wall, {
          a: [d.a.x * k, d.a.y * k],
          b: [d.b.x * k, d.b.y * k],
          height: d.height * k,
          thickness: d.thickness * k,
          elevation: d.elevation * k,
          material: this.materialRefs.get(d.materialId) ?? null,
        }),
    })
    this.openings = createMirror<OpeningDoc>(world, {
      key: id,
      rev,
      spawn: () => world.spawn(Opening),
      apply: (e, d) =>
        world.set(e, Opening, {
          wall: this.walls.entity(d.hostWallId) ?? null,
          kind: d.kind,
          offset: d.offset * k,
          width: d.width * k,
          height: d.height * k,
          sill: d.sill * k,
          frameWidth: d.frameWidth * k,
          frameDepth: d.frameDepth * k,
          frameMaterial: d.frameMaterialId ? (this.materialRefs.get(d.frameMaterialId) ?? null) : null,
          hinge: d.hinge ?? 'start',
          swing: d.swing ?? 'left',
          state: d.state ?? 'closed',
          sight: d.sight,
          movement: d.movement,
        }),
    })
    this.floors = createMirror<FloorDoc>(world, {
      key: id,
      rev,
      spawn: () => world.spawn(Floor),
      apply: (e, d) =>
        world.set(e, Floor, {
          points: d.points.map((p) => [p.x * k, p.y * k] as [number, number]),
          elevation: d.elevation * k,
          material:
            d.surface.kind === 'material' ? (this.materialRefs.get(d.surface.materialId) ?? null) : null,
        }),
    })
    this.props = createMirror<PropDoc>(world, {
      key: id,
      rev,
      spawn: (d) =>
        world.spawn(
          [Mesh3d, { mesh: this.propMesh(d.asset) }],
          [MeshMaterial, { material: this.materialRefs.values().next().value ?? null }],
          Transform,
        ),
      apply: (e, d) => {
        this.propDocs.set(e, d)
        this.placeProp(e, d)
      },
      despawn: (e) => {
        this.propDocs.delete(e)
        world.despawn(e)
      },
    })
    this.tokens = createMirror<TokenDoc>(world, {
      key: id,
      rev,
      spawn: () => {
        const root = world.spawn(Transform)
        const disc = world.spawn(
          [Mesh3d, { mesh: this.disc() }],
          [MeshMaterial, { material: this.tokenMat() }],
          Transform,
          [ChildOf, { parent: root }],
        )
        this.discs.set(root, disc)
        return root
      },
      apply: (e, d) => {
        this.tokenDocs.set(e, d)
        world.set(e, Transform, { translation: [d.x * k, 0, d.y * k] })
        this.sizeToken(e, d)
      },
      despawn: (e) => {
        this.discs.delete(e)
        this.tokenDocs.delete(e)
        world.despawn(e)
      },
    })
  }

  /** World size of one grid cell: the grid's pixel size through the visual scale. */
  get cell(): number {
    return (this.grid?.size ?? 70) * this.k
  }

  /**
   * Applies a full host state. Only documents whose revision changed are applied. A grid whose
   * pixel size changed resizes cell-sized things (token footprints, props); its game distance,
   * unit and diagonal rule place nothing.
   */
  sync(docs: SceneDocs): HostSyncCounts {
    const counts: HostSyncCounts = { spawned: 0, applied: 0, removed: 0, resized: 0 }
    const add = (c: { spawned: number; applied: number; removed: number }) => {
      counts.spawned += c.spawned
      counts.applied += c.applied
      counts.removed += c.removed
    }
    const resize = this.grid !== undefined && this.grid.size !== docs.grid.size
    this.grid = docs.grid
    add(this.materials.sync(docs.materials))
    add(this.walls.sync(docs.walls))
    add(this.openings.sync(docs.openings))
    add(this.floors.sync(docs.floors))
    add(this.props.sync(docs.props))
    add(this.tokens.sync(docs.tokens))
    if (resize) {
      for (const [e, d] of this.tokenDocs) this.sizeToken(e, d)
      for (const [e, d] of this.propDocs) this.placeProp(e, d)
      counts.resized = this.tokenDocs.size + this.propDocs.size
    }
    return counts
  }

  private sizeToken(root: Entity, d: TokenDoc): void {
    const disc = this.discs.get(root)!
    const footprint = d.size * this.cell * 0.9
    this.world.set(disc, Transform, { translation: [0, 0.03, 0], scale: [footprint, 0.06, footprint] })
  }

  private placeProp(e: Entity, d: PropDoc): void {
    const size = d.cells * this.cell
    const a = (d.rotation * Math.PI) / 360
    this.world.set(e, Transform, {
      translation: [d.x * this.k, size / 2, d.y * this.k],
      rotation: [0, Math.sin(a), 0, Math.cos(a)],
      scale: [size, size, size],
    })
  }

  private disc(): AssetRef<'Mesh'> {
    this.discMesh ??= this.world
      .resource(Meshes)
      .add(cylinder({ radius: 0.5, height: 1, segments: 32 }), 'host:token-disc') as AssetRef<'Mesh'>
    return this.discMesh
  }

  private tokenMat(): AssetRef<'Material'> {
    this.tokenMaterial ??= this.world
      .resource(Materials)
      .add(new MaterialAsset({ baseColor: [0.75, 0.2, 0.15, 1], roughness: 0.5 }), 'host:token') as AssetRef<'Material'>
    return this.tokenMaterial
  }

  /**
   * One mesh per prop asset: spheres of about 1,950 triangles, so 256 props come to Aether's
   * 500k prop triangles.
   */
  private propMesh(asset: string): AssetRef<'Mesh'> {
    let ref = this.propMeshes.get(asset)
    if (!ref) {
      const n = Number.parseInt(asset.slice(asset.lastIndexOf('-') + 1), 10) || 0
      const segments = 31 + (n % 3)
      const mesh: Mesh = sphere({ radius: 0.5, segments, rings: segments })
      ref = this.world.resource(Meshes).add(mesh, `host:prop/${asset}`) as AssetRef<'Mesh'>
      this.propMeshes.set(asset, ref)
    }
    return ref
  }
}

/** Mirrors Aether-shaped documents onto `world` (see `HostScene`). */
export function hostScene(world: World, pxToWorld = PX_TO_WORLD): HostScene {
  return new HostScene(world, pxToWorld)
}
