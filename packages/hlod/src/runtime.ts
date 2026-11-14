import {
  type AssetRef,
  ChildOf,
  Children,
  Derived,
  defineResource,
  defineSpan,
  defineSystem,
  type Entity,
  onAdd,
  onRemove,
  ProfilerResource,
  type Query,
  type World,
} from '@aethervtt/shard-core'
import {
  buildProxy,
  Mesh,
  type MeshData,
  type ProxyInput,
  type ProxyOccluder,
  type ProxyOutput,
  type ProxyPart,
} from '@aethervtt/shard-mesh'
import { type Cell, type InstanceRuntime, PartitionState } from '@aethervtt/shard-partition'
import { procgenHost } from '@aethervtt/shard-procgen'
import {
  DrawnByProxy,
  DynamicCaster,
  Lod,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
  MorphWeights,
  NotShadowCaster,
  Occluder,
  SkinnedMesh,
  STANDARD_TYPE,
  Visibility,
} from '@aethervtt/shard-render'
import { LogResource } from '@aethervtt/shard-runtime'
import {
  ContactMesh,
  Structure,
  StructureCameraRegion,
  StructureChunk,
  StructureShadowProxy,
  WindowPane,
} from '@aethervtt/shard-structure'
import { GlobalTransform, Transform } from '@aethervtt/shard-transform'
import { Exclude, HlodProxy, HlodSettings } from './components'

// Runtime HLOD (0073). A cell at a `proxy` level draws as one proxy: its drawn meshes (structure's
// chunks and door leaves, the game's dressed meshes) merged per material on the worker pool, with
// part-size levels of detail inside. While a proxy stands in, the cell root has DrawnByProxy: its
// meshes keep their CPU data (the next build's source) but hold no instance slots, so they cost
// nothing a frame. A cell is gathered when its members have been still for `settleFrames`; the old
// proxy draws until its replacement is ready, and a proxy is kept while its cell is near (full), so
// going back out covers it in the swap frame.

const GATHER = defineSpan('hlod/gather')
const COMMIT = defineSpan('hlod/commit')
const NO_FRAME = -1

/** Where a proxy's build stands, per loaded cell. */
interface ProxyCell {
  readonly key: string
  readonly rt: InstanceRuntime
  cell: Cell
  /** The proxy drawing for it, or null. */
  proxy: Entity | null
  /** Meshes the proxy owns (dropped with it). */
  meshes: AssetRef<'Mesh'>[]
  /**
   * A replacement committed this frame, hidden: it takes over next frame, once transform
   * propagation has placed it, so the cell is never uncovered in between.
   */
  next: { root: Entity; meshes: AssetRef<'Mesh'>[] } | undefined
  /** The last frame a member changed. */
  dirtyFrame: number
  /** The frame the committed (or in-flight) build gathered at. */
  gathered: number
  /** A build on the pool, and its result once back. */
  job: Promise<void> | undefined
  result: { out: ProxyOutput; bins: Bin[]; frame: number } | undefined
  covered: boolean
}

/** One output mesh of a proxy: a material, and whether it casts as itself. */
interface Bin {
  material: AssetRef<'Material'>
  casts: boolean
}

export class HlodState {
  readonly cells = new Map<string, ProxyCell>()
  /** Cell roots whose members changed, waiting to be resolved to their cells. */
  readonly touched = new Set<Entity>()
  frame = 0
  lastReport: unknown = undefined
  window: AssetRef<'Material'> | undefined
  shadow: AssetRef<'Material'> | undefined
  /** Proxies built so far, and last frame's main-thread ms. */
  built = 0
  jobs = 0
  ms = 0
  readonly unreadable = new Set<string>()
  /** Freezes coverage, commits and builds as they are (inspection, per-ring ablation). */
  paused = false
  /** The last 256 builds' ms, as the pool timed them (or inline). */
  readonly buildMs: number[] = []
}

export const Hlod = defineResource<HlodState>('hlod/State', {
  description: 'HLOD proxies per cell (0073): state, jobs in flight, counts.',
  init: () => new HlodState(),
})

/** Whether an entity can be a proxy member: drawn, static and not excluded. */
function memberKind(world: World, e: Entity): boolean {
  return !(
    world.has(e, SkinnedMesh) ||
    world.has(e, MorphWeights) ||
    world.has(e, DynamicCaster) ||
    world.has(e, StructureShadowProxy)
  )
}

/** The cell root above `e` (itself included), if `e` is in a streamed cell. */
function cellRootOf(world: World, e: Entity): Entity | undefined {
  const s = world.tryResource(PartitionState)
  if (!s) return undefined
  let at: Entity | null | undefined = e
  for (let depth = 0; at != null && depth < 64; depth++) {
    if (!world.isAlive(at)) return undefined
    for (const rt of s.instances.values()) if (rt.byRoot.has(at)) return at
    at = world.tryGet(at, ChildOf)?.parent as Entity | null | undefined
  }
  return undefined
}

/** Marks the cell holding `e` as changed, when `e` is a member kind. */
function touch(world: World, state: HlodState, e: Entity): void {
  if (!world.isAlive(e) || !memberKind(world, e)) return
  const root = cellRootOf(world, e)
  if (root !== undefined) state.touched.add(root)
}

/** Watches members coming and going (spawns, despawns, a level respawning). */
export function hookHlod(world: World): void {
  const state = world.resource(Hlod)
  world.observe(onAdd(Mesh3d), ({ entity, world }) => touch(world, state, entity))
  world.observe(onRemove(Mesh3d), ({ entity, world }) => touch(world, state, entity))
  world.observe(onAdd(Occluder), ({ entity, world }) => touch(world, state, entity))
}

const SCRATCH_PARTS: ProxyPart[] = []

/** A matrix of its own: a column view would carry its whole column to the worker. */
const copy = (m: ArrayLike<number>) => Array.from(m)

/**
 * Gathers a cell's members into a build input. Returns undefined when it isn't ready (a mesh or
 * material still loading): the cell is tried again on a later frame.
 */
function gather(
  world: World,
  state: HlodState,
  root: Entity,
): { input: ProxyInput; bins: Bin[] } | undefined {
  const meshes = world.resource(Meshes)
  const materials = world.resource(Materials)
  const settings = world.resource(HlodSettings)
  const parts = SCRATCH_PARTS
  parts.length = 0
  const occluders: ProxyOccluder[] = []
  const bins: Bin[] = []
  const binOf = new Map<string, number>()
  const binFor = (material: AssetRef<'Material'>, casts: boolean) => {
    const key = `${material.guid}|${casts}`
    let b = binOf.get(key)
    if (b === undefined) {
      b = bins.length
      bins.push({ material, casts })
      binOf.set(key, b)
    }
    return b
  }
  let ready = true
  const visit = (e: Entity) => {
    if (!ready || world.has(e, Exclude)) return
    const mode = world.tryGet(e, Visibility)?.mode
    if (mode === 'hidden' || mode === 'shadow-only') return
    const occluder = world.tryGet(e, Occluder)
    const matrix = world.tryGet(e, GlobalTransform)?.matrix
    if (occluder && matrix) {
      const mesh = meshes.get(occluder.mesh)
      if (mesh && !mesh.gpu)
        occluders.push({ positions: mesh.positions, indices: mesh.indices, matrix: copy(matrix) })
    }
    if (world.has(e, Mesh3d) && memberKind(world, e)) {
      if (!matrix) {
        ready = false
        return
      }
      const lod = world.tryGet(e, Lod)
      const ref = lod?.levels[0]?.mesh ?? world.get(e, Mesh3d).mesh
      const mesh = meshes.get(ref)
      const materialRef = world.tryGet(e, MeshMaterial)?.material as AssetRef<'Material'> | null
      const material = materialRef ? materials.get(materialRef) : undefined
      if (!mesh || (materialRef && !material)) {
        ready = false
        return
      }
      if (mesh.gpu) {
        const key = ref?.guid ?? '?'
        if (!state.unreadable.has(key)) {
          state.unreadable.add(key)
          world
            .tryResource(LogResource)
            ?.log('warn', `A proxy member's mesh ${key} has no CPU data; it's left out`, {
              code: 'hlod/mesh-unreadable',
              hint: 'GPU-written meshes (Mesh.gpu) have no vertices to merge.',
            })
        }
      } else if (materialRef && material) {
        const pane = world.has(e, WindowPane)
        // Chunk and region meshes cast through structure's shadow proxies (0116), so they carry
        // NotShadowCaster; contact shade never casts.
        const casts =
          !pane &&
          (!world.has(e, NotShadowCaster) ||
            ((world.has(e, StructureChunk) || world.has(e, StructureCameraRegion)) &&
              !world.has(e, ContactMesh)))
        const merges =
          material.type === STANDARD_TYPE &&
          material.type.blendOf(material.value) === 'opaque' &&
          !material.value.doubleSided
        const bin = pane ? binFor(state.window!, false) : binFor(materialRef, casts && !merges)
        parts.push({ bin, mesh: mesh.data(), matrix: copy(matrix), shadow: casts && merges })
      }
    }
    const children = world.tryGet(e, Children)?.entities
    if (children) for (const c of children) if (c !== null) visit(c as Entity)
  }
  visit(root)
  if (!ready) return undefined
  const levelSizes = [0]
  for (let k = 1; k < settings.lodLevels; k++) levelSizes.push(sizeAt(settings, k))
  return {
    input: {
      parts: parts.slice(),
      bins: bins.length,
      levelSizes,
      occluders,
      occluderRegion: settings.occluderRegion,
      occluderTriangles: settings.occluderTriangles,
    },
    bins,
  }
}

/**
 * The smallest part level k keeps: `pixelError` pixels at 1080 rows and 60°, at twice the distance
 * per level from 96 m. Levels switch by screen size (below), so this only spaces them.
 */
function sizeAt(settings: { pixelError: number }, k: number): number {
  const distance = 96 * 2 ** k
  return (settings.pixelError * 2 * distance * Math.tan(Math.PI / 6)) / 1080
}

/** Runs a build on the pool, or inline when the host has none, and records how long it took. */
async function runBuild(state: HlodState, input: ProxyInput): Promise<ProxyOutput> {
  const host = procgenHost()
  const module = await host.workerModule
  const start = performance.now()
  const out =
    host.workers && host.workers.size > 0 && module
      ? await host.workers.run<ProxyOutput>(module, 'buildProxy', [input], { kind: 'hlod' })
      : buildProxy(input)
  if (state.buildMs.length >= 256) state.buildMs.shift()
  state.buildMs.push(performance.now() - start)
  return out
}

function meshBytes(m: MeshData): number {
  let n = m.positions.byteLength + (m.indices?.byteLength ?? 0)
  for (const a of ['normals', 'uvs', 'tangents', 'colors', 'uvs1'] as const)
    n += m[a]?.byteLength ?? 0
  return n
}

/** Drops a proxy root's entities and its meshes. */
function drop(world: World, root: Entity | null, refs: AssetRef<'Mesh'>[]): void {
  if (root !== null && world.isAlive(root)) world.despawn(root)
  const meshes = world.resource(Meshes)
  for (const ref of refs) if (ref.guid) meshes.delete(ref.guid)
}

/** Drops a cell's proxy and any replacement waiting. */
function dropProxy(world: World, rec: ProxyCell): void {
  drop(world, rec.proxy, rec.meshes)
  if (rec.next) drop(world, rec.next.root, rec.next.meshes)
  rec.proxy = null
  rec.meshes = []
  rec.next = undefined
}

/** Turns a finished build into the cell's next proxy: hidden this frame, it takes over next. */
function commit(world: World, state: HlodState, rec: ProxyCell): number {
  const { out, bins, frame } = rec.result!
  rec.result = undefined
  rec.gathered = frame
  const settings = world.resource(HlodSettings)
  const meshes = world.resource(Meshes)
  if (rec.next) drop(world, rec.next.root, rec.next.meshes)
  rec.next = undefined
  if (out.levels.length === 0) {
    // Nothing drawn: no proxy, and the cell draws (nothing) as itself.
    drop(world, rec.proxy, rec.meshes)
    rec.proxy = null
    rec.meshes = []
    return 0
  }
  let bytes = 0
  const owned: AssetRef<'Mesh'>[] = []
  const add = (data: MeshData): AssetRef<'Mesh'> => {
    const mesh = Mesh.create(data)
    mesh.arena = 'structure'
    bytes += meshBytes(data)
    const ref = meshes.add(mesh) as AssetRef<'Mesh'>
    owned.push(ref)
    return ref
  }
  const root = world.spawn(
    [Transform, {}],
    [Visibility, {}],
    // Parked until it takes over: the cell draws in its place, so it holds no slots.
    DrawnByProxy,
    [ChildOf, { parent: rec.rt.entity }],
    [
      HlodProxy,
      {
        grid: rec.cell.grid.index,
        x: rec.cell.x,
        z: rec.cell.z,
        triangles: out.levels[0]!.triangles,
        levels: out.levels.length,
      },
    ],
    Derived,
  )
  for (let b = 0; b < bins.length; b++) {
    // The levels where this bin's mesh changes, each with the size of the parts the next drops.
    const chain: { data: MeshData; next: number }[] = []
    for (let k = 0; k < out.levels.length; k++) {
      const data = out.levels[k]!.bins[b]
      if (!data) {
        if (chain.length > 0) chain[chain.length - 1]!.next = out.levels[k]!.size
        break
      }
      const last = chain[chain.length - 1]
      if (last && last.data.indices!.length === data.indices!.length) continue
      if (last) last.next = out.levels[k]!.size
      chain.push({ data, next: 0 })
    }
    if (chain.length === 0) continue
    const refs = chain.map((c) => add(c.data))
    const first = meshes.get(refs[0]!)!
    const bb = first.bounds
    const diameter = Math.sqrt(
      (bb[3]! - bb[0]!) ** 2 + (bb[4]! - bb[1]!) ** 2 + (bb[5]! - bb[2]!) ** 2,
    )
    const components: unknown[] = [
      [Mesh3d, { mesh: refs[0] }],
      [MeshMaterial, { material: bins[b]!.material }],
      [Transform, {}],
      [ChildOf, { parent: root }],
      Derived,
    ]
    if (!bins[b]!.casts) components.push(NotShadowCaster)
    // A level draws while its next drop is under `pixelError` pixels: 0103's switch size.
    if (chain.length > 1 || chain[0]!.next > 0)
      components.push([
        Lod,
        {
          levels: chain.map((c, i) => ({
            mesh: refs[i],
            screenSize: c.next > 0 ? (settings.pixelError * diameter) / (c.next * 1080) : 0,
          })),
        },
      ])
    ;(world.spawn as (...c: unknown[]) => Entity)(...components)
  }
  if (out.shadow)
    world.spawn(
      [Mesh3d, { mesh: add(out.shadow) }],
      [MeshMaterial, { material: state.shadow }],
      [Visibility, { mode: 'shadow-only' }],
      [Transform, {}],
      [ChildOf, { parent: root }],
      Derived,
    )
  for (const o of out.occluders)
    world.spawn(
      [Occluder, { mesh: add(o) }],
      [Visibility, {}],
      [Transform, {}],
      [ChildOf, { parent: root }],
      Derived,
    )
  rec.next = { root, meshes: owned }
  state.built++
  return bytes
}

function setCovered(world: World, rec: ProxyCell, covered: boolean): void {
  rec.covered = covered
  const root = rec.cell.root
  if (!world.isAlive(root) || world.has(root, DrawnByProxy) === covered) return
  if (covered) world.add(root, DrawnByProxy, {})
  else world.remove(root, DrawnByProxy)
}

/**
 * Shows a proxy, or parks it: a parked proxy (its cell near enough to draw itself) has
 * DrawnByProxy too, since the cell draws in its place, so it holds no slots while it waits.
 */
function showProxy(world: World, rec: ProxyCell, shown: boolean): void {
  if (rec.proxy === null || !world.isAlive(rec.proxy)) return
  if (world.has(rec.proxy, DrawnByProxy) !== shown) return
  if (shown) world.remove(rec.proxy, DrawnByProxy)
  else world.add(rec.proxy, DrawnByProxy, {})
}

/** Resolves changed members to their cells: marks each cell's last change frame. */
function track(world: World, state: HlodState, changed: Query, since: number): void {
  for (const table of changed.tables) {
    if (
      table.lastChanged(Mesh3d) <= since &&
      table.lastChanged(GlobalTransform) <= since &&
      table.lastChanged(Visibility) <= since &&
      !(table.has(MeshMaterial) && table.lastChanged(MeshMaterial) > since)
    )
      continue
    if (table.has(SkinnedMesh) || table.has(DynamicCaster) || table.has(StructureShadowProxy))
      continue
    const mesh = table.changedTicks(Mesh3d)
    const moved = table.changedTicks(GlobalTransform)
    const shown = table.changedTicks(Visibility)
    const painted = table.has(MeshMaterial) ? table.changedTicks(MeshMaterial) : undefined
    for (let row = 0; row < table.count; row++) {
      if (
        mesh[row]! > since ||
        moved[row]! > since ||
        shown[row]! > since ||
        (painted && painted[row]! > since)
      )
        touch(world, state, table.entities[row]! as Entity)
    }
  }
  // Chunks rebuilt in place (a wall broken) keep their Mesh3d: structure's compile says which.
  const structure = world.tryResource(Structure)
  if (structure && structure.last !== state.lastReport) {
    state.lastReport = structure.last
    for (const group of structure.last.dirtyGroups) touch(world, state, group)
  }
  if (state.touched.size > 0)
    for (const rec of state.cells.values())
      if (state.touched.has(rec.cell.root)) rec.dirtyFrame = state.frame
  state.touched.clear()
}

/**
 * Each frame, after transforms and before visibility: commits finished builds, covers or uncovers
 * every loaded cell, and gathers settled cells whose proxy is missing or stale, nearest first.
 */
export const selectProxies = defineSystem({
  name: 'hlod/select',
  description:
    'Covers cells at proxy levels with their HLOD proxies, commits finished builds and gathers changed cells (0073).',
  setup: (world) => ({
    changed: world.query({ with: [Mesh3d, GlobalTransform, Visibility] }),
  }),
  run: ({ changed }, world, ctx) => {
    const start = performance.now()
    const state = world.resource(Hlod)
    const settings = world.resource(HlodSettings)
    const partition = world.tryResource(PartitionState)
    if (!partition || state.paused) return
    state.frame++
    if (!state.window) {
      const materials = world.resource(Materials)
      state.window = materials.add(
        new MaterialAsset({ baseColor: [...settings.windowColor, 1], roughness: 0.4 }),
        'hlod:window',
      ) as AssetRef<'Material'>
      state.shadow = materials.add(new MaterialAsset({}), 'hlod:shadow') as AssetRef<'Material'>
    }
    // Cells loaded now; records of cells gone drop their proxies.
    const live = new Set<string>()
    for (const rt of partition.instances.values()) {
      for (const cell of rt.cells.values()) {
        if (cell.level < 0 || !world.isAlive(cell.root)) continue
        const key = `${rt.entity}:${cell.key}`
        live.add(key)
        let rec = state.cells.get(key)
        if (!rec) {
          rec = {
            key,
            rt,
            cell,
            proxy: null,
            meshes: [],
            next: undefined,
            dirtyFrame: state.frame,
            gathered: NO_FRAME,
            job: undefined,
            result: undefined,
            covered: false,
          }
          state.cells.set(key, rec)
        }
        rec.cell = cell
      }
    }
    for (const [key, rec] of state.cells) {
      if (live.has(key)) continue
      dropProxy(world, rec)
      state.cells.delete(key)
    }
    track(world, state, changed, ctx.lastRunTick)

    // Finished builds become proxies, within the upload budget (at least one a frame).
    const profiler = world.tryResource(ProfilerResource)
    let token = profiler?.begin(COMMIT)
    let bytes = 0
    const committed = new Map<ProxyCell, Entity>()
    for (const rec of state.cells.values()) {
      if (!rec.result) continue
      if (bytes > 0 && bytes >= settings.uploadBytes) break
      bytes += commit(world, state, rec) || 1
      if (rec.next) committed.set(rec, rec.next.root)
    }
    if (token !== undefined) profiler!.end(token)

    // Coverage: a cell at a proxy level with a proxy is covered, and its proxy draws. A
    // replacement committed on an earlier frame takes over in the same write.
    const want: ProxyCell[] = []
    for (const rec of state.cells.values()) {
      if (rec.next && rec.next.root !== committed.get(rec)) {
        drop(world, rec.proxy, rec.meshes)
        rec.proxy = rec.next.root
        rec.meshes = rec.next.meshes
        rec.next = undefined
      }
      const level = rec.cell.grid.levels[rec.cell.level]
      const proxied = settings.enabled && level?.proxy === true
      const draws = proxied && rec.proxy !== null
      setCovered(world, rec, draws)
      showProxy(world, rec, draws)
      if (
        proxied &&
        rec.job === undefined &&
        !rec.result &&
        (rec.gathered === NO_FRAME || rec.dirtyFrame > rec.gathered) &&
        state.frame - rec.dirtyFrame >= settings.settleFrames
      )
        want.push(rec)
    }

    // Gathers, nearest first, within the budget (at least one a frame) and the jobs cap.
    want.sort((a, b) => a.cell.distance - b.cell.distance)
    token = profiler?.begin(GATHER)
    const gatherStart = performance.now()
    for (const rec of want) {
      if (state.jobs >= settings.jobsInFlight) break
      if (performance.now() - gatherStart > settings.gatherMs && rec !== want[0]) break
      const g = gather(world, state, rec.cell.root)
      if (!g) continue
      const frame = state.frame
      state.jobs++
      rec.job = runBuild(state, g.input).then(
        (out) => {
          state.jobs--
          rec.job = undefined
          if (state.cells.get(rec.key) === rec) rec.result = { out, bins: g.bins, frame }
        },
        (err: unknown) => {
          state.jobs--
          rec.job = undefined
          rec.dirtyFrame = state.frame
          world
            .tryResource(LogResource)
            ?.log('warn', `An HLOD proxy build failed: ${String(err)}`, {
              code: 'hlod/build-failed',
            })
        },
      )
    }
    if (token !== undefined) profiler!.end(token)
    state.ms = performance.now() - start
  },
})

/** Resolves once no build is in flight (tests, deterministic hosts). */
export async function hlodSettled(world: World): Promise<void> {
  const state = world.tryResource(Hlod)
  if (!state) return
  for (;;) {
    const jobs = [...state.cells.values()].map((r) => r.job).filter((j) => j !== undefined)
    if (jobs.length === 0) return
    await Promise.all(jobs)
  }
}

/** Counts per level name, for describe. */
export function describeHlod(world: World) {
  const state = world.tryResource(Hlod)
  const levels: Record<
    string,
    { cells: number; covered: number; shells: number; building: number; stale: number }
  > = {}
  if (!state) return { enabled: false, levels, proxies: 0, triangles: 0, built: 0, jobs: 0, ms: 0 }
  let triangles = 0
  let proxies = 0
  for (const rec of state.cells.values()) {
    const name = rec.cell.grid.levels[rec.cell.level]?.name ?? '?'
    let l = levels[name]
    if (!l) {
      l = { cells: 0, covered: 0, shells: 0, building: 0, stale: 0 }
      levels[name] = l
    }
    l.cells++
    if (rec.covered) l.covered++
    else if (rec.cell.grid.levels[rec.cell.level]?.proxy) l.shells++
    if (rec.job || rec.result) l.building++
    if (rec.proxy !== null && rec.dirtyFrame > rec.gathered) l.stale++
    if (rec.proxy !== null && world.isAlive(rec.proxy)) {
      proxies++
      triangles += world.get(rec.proxy, HlodProxy).triangles
    }
  }
  return {
    enabled: world.resource(HlodSettings).enabled,
    levels,
    proxies,
    triangles,
    built: state.built,
    jobs: state.jobs,
    ms: state.ms,
  }
}
