import { defineComponent, defineResource, t } from '@aethervtt/shard-core'
import { Visibility } from '@aethervtt/shard-render'
import { Grid, Transform } from '@aethervtt/shard-transform'

export const Planet = defineComponent(
  'terrain/Planet',
  {
    radius: t.f64({
      default: 4000,
      min: 1,
      unit: 'm',
      description: 'Surface radius before heights, 1 km to 50 000 km (Earth is 6 371 000).',
    }),
    shape: t.vec3({
      default: [1, 1, 1],
      min: 0.01,
      description: 'Ellipsoid axis ratios: [1, 1, 1] is a sphere, [1, 0.7, 1.2] a lumpy moon.',
    }),
    height: t.handle('NoiseGraph', {
      description:
        'Height graph (*.noise.json), output in [−1, 1], sampled on the sphere of `radius`. None: a smooth sphere.',
    }),
    heightScale: t.f32({
      default: 600,
      min: 0,
      unit: 'm',
      description: 'Metres per unit of the height graph.',
    }),
    seed: t.u32({ description: 'Mixed into every graph: the same graphs make a new planet.' }),
    ocean: t.bool({ default: true, description: 'A sea surface at seaLevel.' }),
    seaLevel: t.f32({ unit: 'm', description: 'Sea surface height above radius.' }),
    climate: t.handle('NoiseGraph', {
      description:
        'Climate graph with nodes named `temperature` and `moisture` (each in [−1, 1]). None: both 0.',
    }),
    biomes: t.handle('terrain/BiomeSet', {
      description: 'Biomes (*.biomes.json): what the surface looks like where.',
    }),
    resolution: t.u16({
      default: 33,
      min: 5,
      max: 129,
      description: 'Vertices per chunk edge, 2^n + 1.',
    }),
    minSpacing: t.f32({
      default: 0.4,
      min: 0.01,
      unit: 'm',
      description: 'Finest vertex spacing: sets the deepest quadtree level.',
    }),
    errorPixels: t.f32({
      default: 2,
      min: 0.1,
      description: 'A chunk splits when its geometric error covers more pixels than this.',
    }),
    vertexPixels: t.f32({
      default: 4,
      min: 0,
      description:
        'Finest on-screen vertex spacing: however rough the terrain, chunks stop splitting once their vertices are this many pixels apart (smaller triangles cost GPU time and show nothing; normal tiles keep the finer relief in the shading). Vertices then morph a few px per frame in fast descents instead of under one. 0: no limit.',
    }),
    colliderRadius: t.f32({
      default: 96,
      min: 0,
      unit: 'm',
      description:
        'Collider chunks (and full-detail rendering) within this distance of every TerrainAnchor, character, and dynamic body.',
    }),
    skirts: t.bool({
      default: true,
      description: 'Walls under chunk edges that hide cracks while neighbors change level.',
    }),
    scatter: t.handle('scatter/ScatterSet', {
      description:
        'Props and foliage everywhere on the planet (*.scatter.json; needs the scatter plugin). Each biome can add its own (Biome.scatter).',
    }),
  },
  {
    description:
      'A planet you can see from orbit and walk on: a cube-sphere quadtree of chunks generated from noise graphs, with biomes, an ocean, colliders near bodies, and navmesh tiles near agents. Needs a Grid (its chunks are grid children); hiding it hides its chunks.',
    requires: [Grid, Transform, Visibility],
  },
)

export const TerrainAnchor = defineComponent(
  'terrain/TerrainAnchor',
  {
    enabled: t.bool({
      default: true,
      description: 'False: this body gets no terrain colliders (a ship in orbit, a projectile).',
    }),
    radius: t.f32({
      min: 0,
      unit: 'm',
      description: 'Collider chunks within this distance (0: the planet’s colliderRadius).',
    }),
  },
  {
    description:
      'Terrain colliders around this entity. Characters and dynamic bodies are anchors without it; add it with enabled: false to opt one out.',
  },
)

export const PlanetNav = defineComponent(
  'terrain/PlanetNav',
  {
    agentRadius: t.f32({ default: 0.4, min: 0, unit: 'm' }),
    agentHeight: t.f32({ default: 1.8, min: 0.01, unit: 'm' }),
    maxSlope: t.f32({ default: 45, min: 0, max: 89.9, unit: 'deg' }),
    radius: t.f32({
      default: 150,
      min: 1,
      unit: 'm',
      description: 'Navmesh around every NavAgent on the planet, this far out.',
    }),
  },
  {
    description:
      'Navigation on a planet: a NavMesh baked from collider chunks near NavAgents, in a tangent frame (up is radial) that follows them.',
    requires: [Planet],
  },
)

export const Chunk = defineComponent(
  'terrain/Chunk',
  {
    planet: t.entity({ readonly: true }),
    key: t.string({ readonly: true, description: 'face/depth/x/y' }),
    kind: t.enum(['render', 'ocean', 'collider'], { readonly: true }),
  },
  {
    description: 'A terrain chunk the planet spawned. Rebuilt from the planet; never saved.',
    serialize: false,
  },
)

export interface TerrainBudgetValue {
  /** Chunks generated per frame, at most. */
  chunksPerFrame: number
  /**
   * Terrain triangles on screen per planet, at most (0: no limit). Past it the planet's detail
   * coarsens a little each frame (a bias on errorPixels) until it fits, and refines back when
   * there's room: frame time holds at any resolution and on any GPU.
   */
  triangles: number
  /** GPU milliseconds per frame for generation (timestamp queries where available). */
  msPerFrame: number
  /** Render chunk slots per planet (meshes kept, evicted least recently used). */
  pool: number
  /** Collider chunks cached per planet. */
  colliderCache: number
  /** Heightfields (0071): GPU page pool slots per terrain (about 22 KB each). */
  pages: number
  /** Heightfields: pages uploaded to the pool per frame, at most. */
  pagesPerFrame: number
}

export const TerrainBudget = defineResource<TerrainBudgetValue>('terrain/Budget', {
  description:
    'How much terrain work a frame may do: chunk generations, GPU milliseconds, page uploads, and how many chunks and pages stay cached.',
  init: () => ({
    chunksPerFrame: 8,
    triangles: 2_000_000,
    msPerFrame: 1.5,
    pool: 2048,
    colliderCache: 256,
    pages: 1024,
    pagesPerFrame: 16,
  }),
})
