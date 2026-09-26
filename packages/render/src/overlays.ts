import {
  type ComponentDef,
  defineResource,
  defineSystem,
  type Entity,
  findComponent,
  type World,
} from '@shard/core'
import type { Mesh } from '@shard/mesh'
import { GlobalTransform, GridFramesResource } from '@shard/transform'
import { ForwardStateResource } from './forward'
import { type GizmoStore, Gizmos } from './gizmos'
import {
  INSTANCE_FLOATS,
  InstanceFlags,
  InstanceSlot,
  type InstanceStore,
  Instances,
} from './instances'
import { DirectionalLight, Lights } from './lights'
import { Views } from './plugin'
import { Cameras, cameraOf } from './view'

export const OVERLAYS = [
  'bounds',
  'lights',
  'cameras',
  'cascades',
  'normals',
  'axes',
  'labels',
] as const
export type Overlay = (typeof OVERLAYS)[number]

/** An overlay another package draws (physics colliders, the navmesh, UI rects). */
export interface OverlayDef {
  name: string
  description: string
  /** Draws into gizmos. `passes(entity)` applies the overlay filter (components and path). */
  draw(world: World, g: GizmoStore, passes: (entity: Entity) => boolean): void
}

const extraOverlays = new Map<string, OverlayDef>()

/** Registers an overlay, so `debug.overlays` and `render.capture` can turn it on by name. */
export function defineOverlay(def: OverlayDef): OverlayDef {
  extraOverlays.set(def.name, def)
  return def
}

/** Every overlay name: the built-in ones, then registered ones. */
export function overlayNames(): string[] {
  return [...OVERLAYS, ...extraOverlays.keys()]
}

export function isOverlayOn(o: DebugOverlaysValue, name: string): boolean {
  return (OVERLAYS as readonly string[]).includes(name)
    ? o[name as Overlay]
    : o.extra[name] === true
}

export interface OverlayFilter {
  /** Only entities with every one of these components (by name, e.g. "render/PointLight"). */
  components: string[]
  /** Only entities whose scene path starts with this. */
  path: string
}

export interface DebugOverlaysValue extends Record<Overlay, boolean> {
  /** Registered overlays (`defineOverlay`) that are on. */
  extra: Record<string, boolean>
  filter: OverlayFilter
  /**
   * An entity's name for labels and the path filter. The default reads the scene path
   * (`scene/SceneMember`) when the scene package is installed.
   */
  name: (world: World, entity: Entity) => string | undefined
}

let memberDef: ComponentDef | null | undefined
function scenePath(world: World, entity: Entity): string | undefined {
  if (memberDef === undefined) memberDef = findComponent('scene/SceneMember') ?? null
  if (!memberDef) return undefined
  const v = world.tryGet(entity, memberDef) as { path?: string } | undefined
  return v?.path || undefined
}

export const DebugOverlays = defineResource<DebugOverlaysValue>('render/DebugOverlays', {
  description:
    'Built-in debug drawings, each drawn through Gizmos: bounds, light volumes, camera frustums, shadow cascades, normals, transform axes, and entity labels.',
  init: () => ({
    bounds: false,
    lights: false,
    cameras: false,
    cascades: false,
    normals: false,
    axes: false,
    labels: false,
    extra: {},
    filter: { components: [], path: '' },
    name: scenePath,
  }),
})

/** Turns overlays on or off; `filter` limits them (see OverlayFilter). */
export function setOverlays(
  world: World,
  on: Partial<Record<string, boolean>>,
  filter?: Partial<OverlayFilter>,
): DebugOverlaysValue {
  const o = world.resource(DebugOverlays)
  for (const name of OVERLAYS) if (on[name] !== undefined) o[name] = on[name]!
  for (const name of extraOverlays.keys()) if (on[name] !== undefined) o.extra[name] = on[name]!
  if (filter) {
    if (filter.components) o.filter.components = filter.components
    if (filter.path !== undefined) o.filter.path = filter.path
  }
  return o
}

const BOUNDS = [0.2, 0.9, 1, 1]
const LIGHT = [1, 0.85, 0.3, 1]
const CAMERA = [0.9, 0.9, 0.9, 1]
const CASCADE = [
  [1, 0.3, 0.3, 1],
  [0.3, 1, 0.3, 1],
  [0.3, 0.5, 1, 1],
  [1, 1, 0.3, 1],
]
const NORMAL = [0.4, 0.6, 1, 1]
const AXES = [
  [1, 0.2, 0.2, 1],
  [0.2, 1, 0.2, 1],
  [0.3, 0.5, 1, 1],
]
const LABEL = [1, 1, 1, 1]
const AXES_WIDTH = { width: 2 }
/** Most normals drawn per mesh: dense meshes draw every n-th vertex. */
const NORMALS_PER_MESH = 1500

const a = new Float32Array(3)
const b = new Float32Array(3)

function passes(
  world: World,
  o: DebugOverlaysValue,
  entity: Entity,
  defs: ComponentDef[],
): boolean {
  for (const def of defs) if (!world.has(entity, def)) return false
  if (o.filter.path) {
    const name = o.name(world, entity)
    if (!name?.startsWith(o.filter.path)) return false
  }
  return true
}

/** The mesh a slot draws (LOD sets: their most detailed level). */
export function slotMesh(store: InstanceStore, slot: number): Mesh | undefined {
  const batch = store.batchOf[slot]!
  if (batch >= 0) return store.batches[batch]!.mesh
  if (batch <= -2) {
    const set = store.lodSets[-2 - batch]!
    return store.batches[set.batches[0]!]?.mesh
  }
  return undefined
}

function drawInstances(
  world: World,
  o: DebugOverlaysValue,
  g: GizmoStore,
  defs: ComponentDef[],
): void {
  const store = world.tryResource(Instances)
  if (!store) return
  const f = store.f32
  const u = store.u32
  for (let slot = 0; slot < store.high; slot++) {
    if ((store.flags[slot]! & InstanceFlags.Visible) === 0) continue
    const mesh = slotMesh(store, slot)
    if (!mesh) continue
    const entity = u[slot * INSTANCE_FLOATS + 15]! as Entity
    if (!passes(world, o, entity, defs)) continue
    const off = slot * INSTANCE_FLOATS
    const bb = mesh.bounds
    if (o.bounds) g.bounds(bb, f, off, BOUNDS)
    if (o.labels) {
      // Above the box: its center, raised by the world half height.
      const cx = (bb[0]! + bb[3]!) / 2
      const cy = (bb[1]! + bb[4]!) / 2
      const cz = (bb[2]! + bb[5]!) / 2
      const hy =
        (Math.abs(f[off + 4]!) * (bb[3]! - bb[0]!) +
          Math.abs(f[off + 5]!) * (bb[4]! - bb[1]!) +
          Math.abs(f[off + 6]!) * (bb[5]! - bb[2]!)) /
        2
      a[0] = f[off]! * cx + f[off + 1]! * cy + f[off + 2]! * cz + f[off + 3]!
      a[1] = f[off + 4]! * cx + f[off + 5]! * cy + f[off + 6]! * cz + f[off + 7]! + hy
      a[2] = f[off + 8]! * cx + f[off + 9]! * cy + f[off + 10]! * cz + f[off + 11]!
      g.label(a, o.name(world, entity) ?? `#${entity}`, LABEL)
    }
    if (o.normals && mesh.normals && mesh.normals.length === mesh.positions.length) {
      const n = mesh.positions.length / 3
      const step = Math.max(1, Math.ceil(n / NORMALS_PER_MESH))
      const p = mesh.positions
      const nn = mesh.normals
      const len = Math.max(bb[3]! - bb[0]!, bb[4]! - bb[1]!, bb[5]! - bb[2]!) * 0.08
      for (let v = 0; v < n; v += step) {
        const x = p[v * 3]!
        const y = p[v * 3 + 1]!
        const z = p[v * 3 + 2]!
        for (let r = 0; r < 3; r++) {
          const ro = off + r * 4
          a[r] = f[ro]! * x + f[ro + 1]! * y + f[ro + 2]! * z + f[ro + 3]!
          b[r] = f[ro]! * nn[v * 3]! + f[ro + 1]! * nn[v * 3 + 1]! + f[ro + 2]! * nn[v * 3 + 2]!
        }
        const bl = Math.sqrt(b[0]! * b[0]! + b[1]! * b[1]! + b[2]! * b[2]!) || 1
        for (let r = 0; r < 3; r++) b[r] = a[r]! + (b[r]! / bl) * len
        g.line(a, b, NORMAL)
      }
    }
  }
}

function drawLights(
  world: World,
  o: DebugOverlaysValue,
  g: GizmoStore,
  defs: ComponentDef[],
): void {
  const lights = world.tryResource(Lights)
  if (lights) {
    for (const r of lights.records) {
      if (!r.alive || !passes(world, o, r.entity, defs)) continue
      a[0] = r.x
      a[1] = r.y
      a[2] = r.z
      if (r.kind === 0) {
        g.sphere(a, r.range, LIGHT)
        continue
      }
      // Spot: the axis, and the cone's rim at range with four lines to it.
      const rim = Math.tan((r.outerAngle * Math.PI) / 180) * r.range
      const ex = r.x + r.dx * r.range
      const ey = r.y + r.dy * r.range
      const ez = r.z + r.dz * r.range
      const hx = Math.abs(r.dy) < 0.9 ? 0 : 1
      const hy = Math.abs(r.dy) < 0.9 ? 1 : 0
      let ux = hy * r.dz
      let uy = -hx * r.dz
      let uz = hx * r.dy - hy * r.dx
      const ul = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1
      ux /= ul
      uy /= ul
      uz /= ul
      const vx = r.dy * uz - r.dz * uy
      const vy = r.dz * ux - r.dx * uz
      const vz = r.dx * uy - r.dy * ux
      const SEG = 24
      for (let i = 0; i < SEG; i++) {
        const t0 = (i / SEG) * Math.PI * 2
        const t1 = ((i + 1) / SEG) * Math.PI * 2
        const c0 = Math.cos(t0) * rim
        const s0 = Math.sin(t0) * rim
        const c1 = Math.cos(t1) * rim
        const s1 = Math.sin(t1) * rim
        b[0] = ex + ux * c0 + vx * s0
        b[1] = ey + uy * c0 + vy * s0
        b[2] = ez + uz * c0 + vz * s0
        if (i % 6 === 0) g.line(a, b, LIGHT)
        a[0] = ex + ux * c1 + vx * s1
        a[1] = ey + uy * c1 + vy * s1
        a[2] = ez + uz * c1 + vz * s1
        g.line(b, a, LIGHT)
        a[0] = r.x
        a[1] = r.y
        a[2] = r.z
      }
    }
  }
  for (const table of world.query({ with: [DirectionalLight, GlobalTransform] }).tables) {
    const m = table.column(GlobalTransform, 'matrix') as unknown as Float32Array
    for (let i = 0; i < table.count; i++) {
      if (!passes(world, o, table.entities[i]!, defs)) continue
      const off = i * 12
      a[0] = m[off + 3]!
      a[1] = m[off + 7]!
      a[2] = m[off + 11]!
      // Light travels along -Z.
      b[0] = a[0] - m[off + 2]! * 2
      b[1] = a[1] - m[off + 6]! * 2
      b[2] = a[2] - m[off + 10]! * 2
      g.arrow(a, b, LIGHT)
    }
  }
}

/** The camera views render in order; the first is the one whose frustum you're looking through. */
function primaryCamera(world: World): Entity | undefined {
  let best: Entity | undefined
  let order = Number.POSITIVE_INFINITY
  for (const view of world.resource(Views).list) {
    const cam = cameraOf(view)
    if (cam && view.order < order) {
      order = view.order
      best = cam.entity
    }
  }
  return best
}

/** Draws the enabled overlays into Gizmos (Last, before gizmos upload). */
export const drawOverlays = defineSystem({
  name: 'render/debug-overlays',
  run: (_, world) => {
    const o = world.resource(DebugOverlays)
    const g = world.resource(Gizmos)
    g.overlay.clear()
    let extra = false
    for (const name in o.extra) if (o.extra[name] && extraOverlays.has(name)) extra = true
    if (
      !(o.bounds || o.lights || o.cameras || o.cascades || o.normals || o.axes || o.labels || extra)
    )
      return
    g.beginOverlays()
    try {
      draw(world, o, g)
    } finally {
      g.endOverlays()
    }
  },
})

function draw(world: World, o: DebugOverlaysValue, g: GizmoStore): void {
  {
    const defs: ComponentDef[] = []
    for (const name of o.filter.components) {
      const def = findComponent(name)
      if (def) defs.push(def)
    }
    if (o.bounds || o.labels || o.normals) drawInstances(world, o, g, defs)
    for (const [name, def] of extraOverlays) {
      if (o.extra[name]) def.draw(world, g, (entity) => passes(world, o, entity, defs))
    }
    if (o.lights) drawLights(world, o, g, defs)
    const primary = primaryCamera(world)
    if (o.cameras) {
      for (const [entity, cam] of world.resource(Cameras)) {
        if (entity === primary || !passes(world, o, entity, defs)) continue
        g.frustum(cam.viewProjNoJitter, CAMERA)
      }
    }
    if (o.cascades && primary !== undefined) {
      const pv = world.tryResource(ForwardStateResource)?.views.get(`camera:${primary}`)
      if (pv) {
        for (let i = 0; i < pv.cascades.count; i++) {
          g.frustum(pv.cascades.views[i]!.viewProj, CASCADE[i % CASCADE.length]!)
        }
      }
    }
    if (o.axes || o.labels) {
      for (const table of world.query({ with: [GlobalTransform] }).tables) {
        const m = table.column(GlobalTransform, 'matrix') as unknown as Float32Array
        // Entities with a mesh are labeled above their bounds (drawInstances).
        const meshed = table.has(InstanceSlot)
        for (let i = 0; i < table.count; i++) {
          const entity = table.entities[i]!
          if (!passes(world, o, entity, defs)) continue
          const off = i * 12
          a[0] = m[off + 3]!
          a[1] = m[off + 7]!
          a[2] = m[off + 11]!
          if (o.axes) {
            for (let k = 0; k < 3; k++) {
              b[0] = a[0] + m[off + k]!
              b[1] = a[1] + m[off + 4 + k]!
              b[2] = a[2] + m[off + 8 + k]!
              g.line(a, b, AXES[k]!, AXES_WIDTH)
            }
          }
          // Named entities without a mesh (cameras, lights, groups) get labels at their origin.
          if (o.labels && !meshed) {
            const name = o.name(world, entity)
            if (name) g.label(a, name, LABEL)
          }
        }
      }
    }
  }
}

const GRID_CELL = [0.3, 1, 0.5, 1]
const NEIGHBOR = [0.3, 0.6, 1, 0.45]
const ga = new Float32Array(3)
const gb = new Float32Array(3)
const GRID_LINE = { width: 1.5 }
const CELL_LINE = { width: 2.5 }

/**
 * `grids`: the origin cell's bounds and the edges of its 26 neighbors, in the origin grid. The
 * origin frame is the origin grid's own frame with the origin cell's centre at (0, 0, 0), so the
 * origin cell spans ±cellSize/2 on each axis.
 */
export const gridsOverlay = defineOverlay({
  name: 'grids',
  description:
    "Large worlds: the floating origin's cell (bright) and its neighbors' edges, in the origin grid.",
  draw: (world, g) => {
    const frames = world.tryResource(GridFramesResource)
    if (!frames?.active || frames.originSlot === 0) return
    const cs = frames.cellSize[frames.originSlot]!
    if (!(cs > 0)) return
    const h = cs / 2
    // Lattice lines of the 3×3×3 block: along each axis, at every pair of the other two coordinates.
    for (let axis = 0; axis < 3; axis++) {
      const u = (axis + 1) % 3
      const v = (axis + 2) % 3
      for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
          const pu = (i - 1.5) * cs
          const pv = (j - 1.5) * cs
          ga[axis] = -3 * h
          gb[axis] = 3 * h
          ga[u] = gb[u] = pu
          ga[v] = gb[v] = pv
          g.line(ga, gb, NEIGHBOR, GRID_LINE)
        }
      }
      // The origin cell's four edges along this axis.
      for (let k = 0; k < 4; k++) {
        ga[axis] = -h
        gb[axis] = h
        ga[u] = gb[u] = k & 1 ? h : -h
        ga[v] = gb[v] = k & 2 ? h : -h
        g.line(ga, gb, GRID_CELL, CELL_LINE)
      }
    }
  },
})
