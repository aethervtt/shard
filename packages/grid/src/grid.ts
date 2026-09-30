import {
  type AssetRef,
  ChildOf,
  defineComponent,
  defineResource,
  defineSystem,
  type Entity,
  onRemove,
  t,
  type World,
} from '@aethervtt/shard-core'
import { plane } from '@aethervtt/shard-mesh'
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
import { Transform } from '@aethervtt/shard-transform'

// The tabletop grid (0057): one quad in the grid band, its lines drawn analytically in the
// fragment shader, antialiased from screen derivatives so they stay `lineWidth` CSS pixels wide
// at any zoom and density. Lines closer than 3 pixels apart fade out (no moiré at grazing angles).

export const GRID_KINDS = ['square', 'hex'] as const
export const HEX_ORIENTATIONS = ['pointy', 'flat'] as const

export const Grid = defineComponent(
  'grid/Grid',
  {
    kind: t.enum(GRID_KINDS, { description: 'Square cells, or hexes.' }),
    orientation: t.enum(HEX_ORIENTATIONS, {
      description: 'Hex grids: pointy-top (rows of hexes) or flat-top (columns).',
    }),
    size: t.f32({
      default: 1.5,
      min: 0.0001,
      unit: 'm',
      description:
        'Square: cell edge. Hex: distance between adjacent cell centres. Visual: a host converts it with its one fixed scale; game distance never sets it.',
    }),
    offset: t.vec2({
      description: 'Where cell (0, 0) starts (square) or is centred (hex), world (x, z).',
    }),
    color: t.color({ default: [0, 0, 0, 1], description: 'Line color (linear).' }),
    opacity: t.f32({ default: 0.5, min: 0, max: 1, description: 'Line opacity.' }),
    lineWidth: t.f32({
      default: 1,
      min: 0,
      unit: 'px',
      description: 'Line width in CSS pixels, at every zoom and display density.',
    }),
    extent: t.vec2({
      default: [100, 100],
      description: 'Size of the drawn area, (x, z) in world units, centred on the entity.',
    }),
  },
  {
    description:
      "A square or hex grid drawn as one quad in the grid band (20) at the entity's height. Game distance (per cell, unit, diagonal rule) isn't here: it measures (grid/math distance), it never draws.",
    requires: [Transform],
  },
)

export const GridLines = defineMaterial('grid/GridLines', {
  extends: 'none',
  blend: 'premultiplied',
  // Lines over the table, not a thing on it: picks reach the tiles and floor under them.
  pickable: false,
  fields: {
    color: t.color({ default: [0, 0, 0, 1], description: 'Line color (linear), alpha included.' }),
    lineWidth: t.f32({ default: 1, min: 0, description: 'CSS pixels.' }),
    size: t.f32({ default: 1, min: 0.0001, description: 'World units.' }),
    offset: t.vec2({ description: 'World (x, z).' }),
    mode: t.f32({ description: '0 square, 1 pointy hex, 2 flat hex.' }),
  },
  shader: 'grid::lines',
  description: 'Analytic grid lines of constant CSS-pixel width (0057). One per Grid.',
})

export const GRID_SHADERS: Record<string, string> = {
  'grid::lines': `
import shard::pbr::types::VertexOutput;
import shard::view::view;
import material::grid_lines::GridLines;

const SQRT3: f32 = 1.7320508;

/** World distance to the nearest edge of a pointy-top hex tiling, and that edge's normal. */
fn hex_edge(p: vec2f, s: f32) -> vec3f {
  let r = (2.0 * p.y) / (SQRT3 * s);
  let q = p.x / s - r / 2.0;
  let x = q;
  let z = r;
  let y = -x - z;
  var rx = round(x);
  var ry = round(y);
  var rz = round(z);
  let dx = abs(rx - x);
  let dy = abs(ry - y);
  let dz = abs(rz - z);
  if (dx > dy && dx > dz) { rx = -ry - rz; } else if (dy > dz) { ry = -rx - rz; } else { rz = -rx - ry; }
  let c = vec2f(s * (rx + rz / 2.0), s * (SQRT3 / 2.0) * rz);
  let d = p - c;
  let a = abs(d);
  let sg = select(vec2f(-1.0), vec2f(1.0), d >= vec2f(0.0));
  // Edge normals of a pointy-top hex: 0° and ±60° (inradius s / 2).
  let slant = dot(a, vec2f(0.5, SQRT3 / 2.0));
  if (a.x >= slant) { return vec3f(s * 0.5 - a.x, sg.x, 0.0); }
  return vec3f(s * 0.5 - slant, sg.x * 0.5, sg.y * SQRT3 / 2.0);
}

/** Pixels from the line: the world distance over world units per pixel along the normal. */
fn pixels(d: f32, n: vec2f, p: vec2f) -> f32 {
  let g = vec2f(dot(dpdx(p), n), dot(dpdy(p), n));
  return d / max(length(g), 1e-8);
}

override fn shade(in: VertexOutput) -> vec4f {
  let p = in.world_position.xz - GridLines.offset;
  let s = GridLines.size;
  var d_px: f32;
  var spacing: f32;
  if (GridLines.mode < 0.5) {
    let f = abs(fract(p / s + 0.5) - 0.5) * s;
    let dx = pixels(f.x, vec2f(1.0, 0.0), p);
    let dz = pixels(f.y, vec2f(0.0, 1.0), p);
    d_px = min(dx, dz);
    spacing = min(pixels(s, vec2f(1.0, 0.0), p), pixels(s, vec2f(0.0, 1.0), p));
  } else {
    // Flat-top hexes are pointy-top ones with x and z swapped.
    let flat = GridLines.mode > 1.5;
    let q = select(p, p.yx, flat);
    let e = hex_edge(q, s);
    let n = select(e.yz, e.zy, flat);
    d_px = pixels(e.x, n, p);
    spacing = pixels(s, n, p);
  }
  let width = GridLines.lineWidth * view.pixelScale.x;
  var a = clamp(width * 0.5 + 0.5 - d_px, 0.0, 1.0);
  a *= smoothstep(3.0, 6.0, spacing) * GridLines.color.a;
  if (a <= 0.0) { discard; }
  // Display-referred, like any overlay: the scene's exposure doesn't dim it.
  return vec4f(GridLines.color.rgb * a / view.exposure, a);
}`,
}

/** The quad and material a Grid draws with. */
export const GridQuad = defineComponent(
  'grid/GridQuad',
  { grid: t.entity({ readonly: true, description: 'The Grid this quad draws.' }) },
  {
    description: "A Grid's quad: spawned and kept by the grid plugin.",
    serialize: false,
    save: false,
  },
)

interface GridRecord {
  quad: Entity
  material: AssetRef<'Material'>
}

export interface GridStateValue {
  grids: Map<Entity, GridRecord>
  quad: AssetRef<'Mesh'> | undefined
  /** Grids removed since the last sync. */
  removed: Entity[]
}

export const GridState = defineResource<GridStateValue>('grid/State', {
  description: "Each Grid entity's quad and material.",
  init: () => ({ grids: new Map(), quad: undefined, removed: [] }),
})

const MODES = { square: 0, pointy: 1, flat: 2 } as const

/** A Grid's material values. */
function lineValues(v: {
  kind: 'square' | 'hex'
  orientation: 'pointy' | 'flat'
  size: number
  offset: number[]
  color: number[]
  opacity: number
  lineWidth: number
}) {
  return {
    color: [v.color[0]!, v.color[1]!, v.color[2]!, v.color[3]! * v.opacity],
    lineWidth: v.lineWidth,
    size: v.size,
    offset: [v.offset[0]!, v.offset[1]!],
    mode: v.kind === 'square' ? MODES.square : MODES[v.orientation],
  }
}

/** Keeps each Grid's quad and material in step with it; drops them when the Grid goes. */
export const syncGrids = defineSystem({
  name: 'grid/sync',
  description: "Keeps each Grid's quad (size, band) and line material in step with the Grid.",
  setup: (world) => ({ q: world.query({ with: [Grid] }) }),
  run: ({ q }, world, ctx) => {
    const state = world.resource(GridState)
    if (state.removed.length > 0) {
      for (const e of state.removed) dropGrid(world, state, e)
      state.removed.length = 0
    }
    const since = ctx.lastRunTick
    for (const table of q.tables) {
      const grounded = table.has(GroundLayer)
      if (table.lastChanged(Grid) <= since && !(grounded && table.lastChanged(GroundLayer) > since))
        continue
      const ticks = table.changedTicks(Grid)
      const groundTicks = grounded ? table.changedTicks(GroundLayer) : undefined
      for (let row = 0; row < table.count; row++) {
        if (ticks[row]! <= since && !(groundTicks && groundTicks[row]! > since)) continue
        updateGrid(world, state, table.entities[row]! as Entity)
      }
    }
  },
})

function updateGrid(world: World, state: GridStateValue, e: Entity): void {
  const v = world.get(e, Grid)
  const band = world.tryGet(e, GroundLayer) ?? { band: GROUND_BANDS.grid, order: 0 }
  let rec = state.grids.get(e)
  const materials = world.resource(Materials)
  if (!rec) {
    state.quad ??= world.resource(Meshes).add(plane({ size: 1 }), 'grid:quad') as AssetRef<'Mesh'>
    const material = materials.add(
      new MaterialAsset(lineValues(v), GridLines),
      `grid:lines/${e}`,
    ) as AssetRef<'Material'>
    const quad = world.spawn(
      [Mesh3d, { mesh: state.quad }],
      [MeshMaterial, { material }],
      [GroundLayer, band],
      [GridQuad, { grid: e }],
      NotShadowCaster,
      Transform,
      [ChildOf, { parent: e }],
    )
    rec = { quad, material }
    state.grids.set(e, rec)
  } else {
    materials.get(rec.material)?.set(lineValues(v))
    world.set(rec.quad, GroundLayer, band)
  }
  // A child of its Grid: it follows the Grid's transform, at the extent's size.
  world.set(rec.quad, Transform, { scale: [v.extent[0]!, 1, v.extent[1]!] })
}

function dropGrid(world: World, state: GridStateValue, e: Entity): void {
  const rec = state.grids.get(e)
  if (!rec) return
  state.grids.delete(e)
  if (world.isAlive(rec.quad)) world.despawn(rec.quad)
  const materials = world.resource(Materials)
  const material = materials.get(rec.material)
  if (material) world.tryResource(GpuAssetsResource)?.releaseMaterial(material)
  materials.delete(rec.material.guid!)
}

export function observeGridRemovals(world: World): void {
  world.observe(onRemove(Grid), ({ entity, world: w }) => {
    w.tryResource(GridState)?.removed.push(entity)
  })
}
