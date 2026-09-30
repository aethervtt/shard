import {
  type AssetRef,
  defineComponent,
  defineResource,
  defineSystem,
  type Entity,
  onRemove,
  ShardError,
  t,
  type World,
} from '@aethervtt/shard-core'
import { Mesh } from '@aethervtt/shard-mesh'
import {
  defineMaterial,
  GpuAssetsResource,
  GROUND_BANDS,
  GroundLayer,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
  NotShadowCaster,
} from '@aethervtt/shard-render'
import { LogResource } from '@aethervtt/shard-runtime'
import { parseGeometry, tessellate } from './tessellate'

export const STROKE_UNITS = ['world', 'css-px'] as const

export const VectorShape = defineComponent(
  'vector/VectorShape',
  {
    geometry: t.json({
      default: { kind: 'rect', width: 1, height: 1 },
      description:
        "Local (x, z) shape: { kind: 'pen', points } | { kind: 'line', from, to } | { kind: 'rect', width, height } (from the origin) | { kind: 'ellipse', rx, ry } (centred) | { kind: 'cone', length, angle } (apex at the origin, along +x, angle in degrees) | { kind: 'polygon', outer, holes }.",
    }),
    stroke: t.color({
      default: [0, 0, 0, 1],
      description: 'Stroke color (linear), alpha included.',
    }),
    strokeWidth: t.f32({
      default: 2,
      min: 0,
      description: 'Stroke width, in strokeUnits. 0: none.',
    }),
    strokeUnits: t.enum(STROKE_UNITS, {
      description:
        'world: scales with the map. css-px: the same on screen at any zoom (widened per view, never rebuilt).',
    }),
    fill: t.color({
      default: [1, 1, 1, 1],
      description: 'Fill color (linear), for closed shapes.',
    }),
    fillOpacity: t.f32({ min: 0, max: 1, description: 'Fill opacity. 0: no fill.' }),
    rev: t.u32({
      description: 'Revision of the geometry and stroke: the mesh is rebuilt only when it changes.',
    }),
  },
  {
    description:
      'A vector drawing on the table (0057): stroke and fill, tessellated once per rev, drawn in the drawings band (30) unless it has its own GroundLayer.',
  },
)

export const VectorMaterial = defineMaterial('vector/VectorMaterial', {
  extends: 'none',
  blend: 'premultiplied',
  fields: {
    stroke: t.color({ default: [0, 0, 0, 1] }),
    fill: t.color({ default: [1, 1, 1, 1] }),
  },
  shader: 'vector::shape',
  description: "A vector shape's stroke and fill colors (0057). One per VectorShape.",
})

export const VECTOR_SHADERS: Record<string, string> = {
  'vector::shape': `
import shard::pbr::types::VertexOutput;
import shard::view::view;
import shard::mesh::{ vertex_tangent, vertex_world };
import material::vector_material::VectorMaterial;

/** CSS-pixel strokes: offset (tangent xyz) × half width in CSS px (w) × this view's pixel size. */
override fn vertex_position(position: vec3f, normal: vec3f, uv: vec2f) -> vec3f {
  let t = vertex_tangent();
  if (t.w <= 0.0) { return position; }
  let world = vertex_world(position);
  var per_px = view.pixelScale.x * view.pixelScale.y;
  if (view.pixelScale.z < 0.5) { per_px *= max(-(view.view * vec4f(world, 1.0)).z, 1e-4); }
  // Offsets are in world units; undo the instance's (uniform) scale.
  let scale = length(vertex_world(position + vec3f(1.0, 0.0, 0.0)) - world);
  return position + t.xyz * (t.w * per_px / max(scale, 1e-6));
}

override fn shade(in: VertexOutput) -> vec4f {
  let c = select(VectorMaterial.fill, VectorMaterial.stroke, in.uv.x > 0.5);
  if (c.a <= 0.0) { discard; }
  // Display-referred: the scene's exposure doesn't dim a drawing.
  return vec4f(c.rgb * c.a / view.exposure, c.a);
}`,
}

interface ShapeRecord {
  /** Absent while the shape has nothing to draw. */
  mesh: AssetRef<'Mesh'> | undefined
  material: AssetRef<'Material'>
  rev: number
  strokeWidth: number
  strokeUnits: string
  filled: boolean
}

export interface VectorStateValue {
  shapes: Map<Entity, ShapeRecord>
  removed: Entity[]
  /** Rebuilds since start (tessellations). */
  rebuilds: number
  /** The densest zoom, CSS px per world unit: curves are fine to half a pixel there. */
  pixelsPerUnit: number
}

export const VectorState = defineResource<VectorStateValue>('vector/State', {
  description: "Each VectorShape's mesh and material, and how many rebuilds ran.",
  init: () => ({ shapes: new Map(), removed: [], rebuilds: 0, pixelsPerUnit: 256 }),
})

function materialValues(v: { stroke: number[]; fill: number[]; fillOpacity: number }) {
  return {
    stroke: [...v.stroke],
    fill: [v.fill[0]!, v.fill[1]!, v.fill[2]!, v.fill[3]! * v.fillOpacity],
  }
}

/**
 * Tessellates changed VectorShapes whose rev (or stroke width, units, or fill) changed, and keeps
 * their material's colors current. Adds Mesh3d, MeshMaterial and a drawings-band GroundLayer.
 */
export const syncShapes = defineSystem({
  name: 'vector/sync',
  description: 'Rebuilds VectorShape meshes when their rev changes; keeps colors current.',
  setup: (world) => ({ q: world.query({ with: [VectorShape] }), changed: [] as Entity[] }),
  run: ({ q, changed }, world, ctx) => {
    const state = world.resource(VectorState)
    if (state.removed.length > 0) {
      for (const e of state.removed) dropShape(world, state, e)
      state.removed.length = 0
    }
    const since = ctx.lastRunTick
    changed.length = 0
    for (const table of q.tables) {
      if (table.lastChanged(VectorShape) <= since) continue
      const ticks = table.changedTicks(VectorShape)
      for (let row = 0; row < table.count; row++)
        if (ticks[row]! > since) changed.push(table.entities[row]! as Entity)
    }
    for (const e of changed) updateShape(world, state, e)
  },
})

function updateShape(world: World, state: VectorStateValue, e: Entity): void {
  const v = world.get(e, VectorShape)
  const filled = v.fillOpacity > 0 && v.fill[3]! > 0
  let rec = state.shapes.get(e)
  const needsMesh =
    !rec ||
    rec.rev !== v.rev ||
    rec.strokeWidth !== v.strokeWidth ||
    rec.strokeUnits !== v.strokeUnits ||
    rec.filled !== filled
  let data: ReturnType<typeof tessellate> | undefined
  if (needsMesh) {
    try {
      const geometry = parseGeometry(v.geometry)
      data = tessellate(
        geometry,
        { strokeWidth: v.strokeWidth, strokeUnits: v.strokeUnits, fill: filled },
        { pixelsPerUnit: state.pixelsPerUnit },
      )
      state.rebuilds++
    } catch (err) {
      if (!(err instanceof ShardError)) throw err
      world.tryResource(LogResource)?.log('warn', `VectorShape ${e}: ${err.message}`, {
        code: err.code,
        path: err.path,
        hint: err.hint,
      })
      return
    }
  }
  const materials = world.resource(Materials)
  if (!rec) {
    const material = materials.add(
      new MaterialAsset(materialValues(v), VectorMaterial),
      `vector:shape/${e}`,
    ) as AssetRef<'Material'>
    rec = {
      mesh: undefined,
      material,
      rev: v.rev,
      strokeWidth: v.strokeWidth,
      strokeUnits: v.strokeUnits,
      filled,
    }
    state.shapes.set(e, rec)
    world.add(e, MeshMaterial, { material })
    if (!world.has(e, NotShadowCaster)) world.add(e, NotShadowCaster)
    if (!world.has(e, GroundLayer)) world.add(e, GroundLayer, { band: GROUND_BANDS.drawings })
  } else materials.get(rec.material)?.set(materialValues(v))
  if (data) {
    // A shape with nothing to draw (no fill, no stroke) has no mesh: it leaves the draw lists
    // until it has geometry again.
    if (data.indices.length === 0) {
      if (world.has(e, Mesh3d)) world.remove(e, Mesh3d)
    } else {
      const meshes = world.resource(Meshes)
      if (rec.mesh) meshes.get(rec.mesh)?.update(data)
      else rec.mesh = meshes.add(Mesh.create(data), `vector:shape/${e}`) as AssetRef<'Mesh'>
      if (!world.has(e, Mesh3d)) world.add(e, Mesh3d, { mesh: rec.mesh })
    }
  }
  rec.rev = v.rev
  rec.strokeWidth = v.strokeWidth
  rec.strokeUnits = v.strokeUnits
  rec.filled = filled
}

function dropShape(world: World, state: VectorStateValue, e: Entity): void {
  const rec = state.shapes.get(e)
  if (!rec) return
  state.shapes.delete(e)
  const meshes = world.resource(Meshes)
  const materials = world.resource(Materials)
  const gpu = world.tryResource(GpuAssetsResource)
  if (rec.mesh) {
    const mesh = meshes.get(rec.mesh)
    if (mesh) gpu?.releaseMesh(mesh)
    meshes.delete(rec.mesh.guid!)
  }
  const material = materials.get(rec.material)
  if (material) gpu?.releaseMaterial(material)
  materials.delete(rec.material.guid!)
  if (world.isAlive(e)) {
    if (world.has(e, Mesh3d)) world.remove(e, Mesh3d)
    if (world.has(e, MeshMaterial)) world.remove(e, MeshMaterial)
  }
}

export function observeShapeRemovals(world: World): void {
  world.observe(onRemove(VectorShape), ({ entity, world: w }) => {
    w.tryResource(VectorState)?.removed.push(entity)
  })
}
