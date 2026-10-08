import { defineSystem, type Entity, type World } from '@aethervtt/shard-core'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { RigidBody } from '@aethervtt/shard-physics'
import {
  addRenderFeatures,
  GpuAssetsResource,
  Graph,
  RenderPhase,
  Shaders,
} from '@aethervtt/shard-render'
import type { App } from '@aethervtt/shard-runtime'
import { GlobalTransform } from '@aethervtt/shard-transform'
import { type AnchorQueries, anchorQueries } from '../colliders'
import { TerrainAnchor } from '../components'
import { TerrainWorld } from '../heights'
import { Terrain } from './component'
import { HEIGHTFIELD_SHADERS } from './material'
import { enqueueResident, type HeightfieldRender } from './render'
import { HeightfieldRuntime } from './runtime'

const seen = new Set<Entity>()
const p = new Float64Array(3)

/**
 * Anchors on a heightfield this frame, in its frame: every TerrainAnchor (unless disabled),
 * character, awake dynamic body and NavAgent within reach of the terrain's ground.
 */
export function gatherHeightfieldAnchors(_world: World, rt: HeightfieldRuntime, q: AnchorQueries) {
  const s = rt.settings!
  const layout = rt.layout!
  seen.clear()
  rt.anchors = 0
  rt.anchorEntity.length = 0
  const top = rt.hi
  const add = (entity: Entity, m: Float32Array, row: number, radius: number) => {
    if (seen.has(entity)) return
    seen.add(entity)
    rt.frame.pointToPlanet(m[row * 12 + 3]!, m[row * 12 + 7]!, m[row * 12 + 11]!, p)
    // Off the terrain, or too high above it to need ground.
    if (
      p[0]! < -radius ||
      p[2]! < -radius ||
      p[0]! > layout.sizeX + radius ||
      p[2]! > layout.sizeZ + radius
    )
      return
    if (p[1]! - top > radius) return
    const i = rt.anchors++
    if (rt.anchorPos.length < rt.anchors * 3) {
      const pos = new Float64Array(rt.anchors * 6)
      pos.set(rt.anchorPos)
      rt.anchorPos = pos
      const r = new Float64Array(rt.anchors * 2)
      r.set(rt.anchorRadius)
      rt.anchorRadius = r
    }
    rt.anchorPos[i * 3] = p[0]!
    rt.anchorPos[i * 3 + 1] = p[1]!
    rt.anchorPos[i * 3 + 2] = p[2]!
    rt.anchorRadius[i] = radius
    rt.anchorEntity.push(entity)
  }
  for (const table of q.anchors.tables) {
    const enabled = table.column(TerrainAnchor, 'enabled')
    const radius = table.column(TerrainAnchor, 'radius')
    const m = table.column(GlobalTransform, 'matrix') as Float32Array
    for (let row = 0; row < table.count; row++) {
      const entity = table.entities[row]!
      if (!enabled[row]) {
        seen.add(entity)
        continue
      }
      add(entity, m, row, radius[row]! > 0 ? radius[row]! : s.colliderRadius)
    }
  }
  for (const table of q.agents.tables) {
    const m = table.column(GlobalTransform, 'matrix') as Float32Array
    for (let row = 0; row < table.count; row++) add(table.entities[row]!, m, row, s.colliderRadius)
  }
  for (const table of q.characters.tables) {
    const m = table.column(GlobalTransform, 'matrix') as Float32Array
    for (let row = 0; row < table.count; row++) add(table.entities[row]!, m, row, s.colliderRadius)
  }
  for (const table of q.bodies.tables) {
    const kind = table.column(RigidBody, 'kind')
    const m = table.column(GlobalTransform, 'matrix') as Float32Array
    for (let row = 0; row < table.count; row++) {
      if (kind[row] !== 0) continue // dynamic only
      add(table.entities[row]!, m, row, s.colliderRadius)
    }
  }
}

/** Per-frame hooks other modules add (colliders, navigation, scatter). */
export const heightfieldUpdates: ((world: World, rt: HeightfieldRuntime, frame: number) => void)[] =
  []

/**
 * Keeps a runtime per Terrain (spec 0071): reads its settings, resolves and compiles its source,
 * checks and bakes its packs, tracks its frame against the floating origin, and gathers anchors.
 * Runs with or without a GPU; colliders and the render side build on it.
 */
export const updateHeightfields = defineSystem({
  name: 'terrain/heightfields',
  description:
    'Resolves each Terrain’s source, bakes its packs when missing or stale (on first use), loads its coarse levels, and gathers the anchors its colliders follow.',
  setup: (world) => ({
    terrains: world.query({ with: [Terrain] }),
    anchors: anchorQueries(world),
  }),
  run: (s, world) => {
    const state = world.resource(TerrainWorld)
    const frame = state.frame
    for (const table of s.terrains.tables) {
      for (let row = 0; row < table.count; row++) {
        const entity = table.entities[row]!
        if (!state.heightfields.has(entity))
          state.heightfields.set(entity, new HeightfieldRuntime(entity))
      }
    }
    const env = { fs: state.fs, workers: state.workers }
    for (const rt of state.heightfields.values()) {
      if (!world.isAlive(rt.entity)) continue
      rt.refresh(world, env)
      rt.frame.update(world, rt.entity)
      if (!rt.ready) continue
      gatherHeightfieldAnchors(world, rt, s.anchors)
      for (const update of heightfieldUpdates) update(world, rt, frame)
      // Once streaming, the coarse levels go to the GPU pool (the render side made).
      const r = rt.parts.get('render') as HeightfieldRender | undefined
      if (r && rt.streaming && (r as { resident?: number }).resident !== rt.version) {
        ;(r as { resident?: number }).resident = rt.version
        enqueueResident(rt, r)
      }
    }
  },
})

const ownBytes = new Map<number, DataView>()

/** Writes each heightfield material's per-frame uniforms straight into its GPU buffer. */
function writeUniforms(world: World, gpu: GpuContext): void {
  const state = world.tryResource(TerrainWorld)
  const assets = world.tryResource(GpuAssetsResource)
  if (!state || !assets) return
  for (const rt of state.heightfields.values()) {
    const r = rt.parts.get('render') as HeightfieldRender | undefined
    if (!r) continue
    const material = r.material
    const gm = assets.materials.get(material)
    const layout = material.type.layout
    if (!gm?.ownBuffer || !layout || gm.version !== material.version) continue
    let view = ownBytes.get(layout.size)
    if (!view) {
      view = new DataView(new ArrayBuffer(layout.size))
      ownBytes.set(layout.size, view)
    }
    layout.write(view, 0, material.value as never)
    gpu.device.queue.writeBuffer(gm.ownBuffer, 0, view.buffer, 0, layout.size)
  }
}

/** Registers the heightfield shaders, its render feature, and its uniform node (GPU up). */
export function registerHeightfield(app: App): void {
  const graph = app.world.tryResource(Graph)
  if (!graph) return
  for (const [path, source] of Object.entries(HEIGHTFIELD_SHADERS))
    app.world.resource(Shaders).register(path, source, '@aethervtt/shard-terrain')
  addRenderFeatures(app.world, {
    name: 'terrain/heightfield',
    description:
      'Heightfield terrain: one grid mesh drawn per streamed page, heights fetched in the vertex stage.',
    nodes: ['terrain/heightfield'],
    baseline: {
      strategy:
        'The same shader: vertex texture fetch of the RGBA8 page pool and the chunk table (WebGL2 texelFetch), pages uploaded with writeTexture. No compute: leaf normals come from the inflate worker.',
    },
    components: [Terrain],
  })
  graph.addNode('terrain/heightfield', {
    kind: 'raw',
    phase: RenderPhase.Setup,
    sideEffects: true,
    run(ctx) {
      writeUniforms(ctx.world, ctx.gpu)
    },
  })
}
