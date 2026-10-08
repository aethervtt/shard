import {
  AssetStore,
  defineAssetSchema,
  defineAssetType,
  defineImporter,
  sha256Hex,
} from '@aethervtt/shard-assets'
import { defineResource, defineSchema, type JsonValue, ShardError } from '@aethervtt/shard-core'
import {
  parseTerrainSource,
  type SourceRef,
  sourceDependencies,
  type TerrainLayout,
  type TerrainSource,
  terrainLayout,
} from './source'

/** An asset a terrain source uses: its guid, type, and the hash of its imported contents. */
export interface SourceDependency {
  guid: string
  type: string
  hash: string
}

/** What `*.terrain.json` imports to (spec 0071). */
export interface TerrainSourceArtifact {
  format: 1
  source: TerrainSource
  layout: TerrainLayout
  /** Every asset it uses, by project path. */
  deps: Record<string, SourceDependency>
  /** SHA-256 of the source and its dependencies' hashes: changes with anything a bake reads. */
  hash: string
}

/** A loaded terrain source: what a `Terrain` entity bakes and streams. */
export class TerrainSourceAsset {
  source: TerrainSource
  layout: TerrainLayout
  deps: Record<string, SourceDependency>
  hash: string
  /** Bumps on hot reload. */
  version = 0

  constructor(a: TerrainSourceArtifact) {
    this.source = a.source
    this.layout = a.layout
    this.deps = a.deps
    this.hash = a.hash
  }
}

export const TerrainSources = defineResource<
  AssetStore<TerrainSourceAsset, 'terrain/TerrainSource'>
>('terrain/TerrainSources', {
  description: 'Loaded heightfield terrain sources (*.terrain.json) by guid.',
  init: () => new AssetStore('terrain/TerrainSource'),
})

export const TerrainSourceAssetType = defineAssetType<TerrainSourceAsset>('terrain/TerrainSource', {
  store: TerrainSources,
  load: (artifact) => new TerrainSourceAsset(artifact.json as unknown as TerrainSourceArtifact),
  update: (existing, next) => {
    existing.source = next.source
    existing.layout = next.layout
    existing.deps = next.deps
    existing.hash = next.hash
    existing.version++
  },
  references: (item) =>
    Object.values(item.deps)
      .filter((d) => d.type === 'Texture')
      .map((d) => ({ guid: d.guid })),
})

const NoSettings = defineSchema(
  'terrain/TerrainSourceSettings',
  {},
  { description: 'None: the terrain is the file.' },
)

const EXPECTED: Record<string, string> = {
  noise: 'NoiseGraph',
  heightmaps: 'Heightmap',
  textures: 'Texture',
}

/**
 * `*.terrain.json`: a heightfield terrain's layer stack (spec 0071), validated with pointers into
 * the file, its assets resolved to guids and recorded as import dependencies (editing a noise graph
 * or heightmap re-imports it, and the next bake rebakes the blocks it touches).
 */
export const TerrainSourceImporter = defineImporter({
  name: 'terrain',
  version: 1,
  extensions: ['.terrain.json'],
  settings: NoSettings,
  async import(file, ctx) {
    let json: unknown
    try {
      json = JSON.parse(file.text())
    } catch (cause) {
      throw new ShardError('assets/import-failed', `${file.path} isn't valid JSON`, {
        path: file.path,
        cause,
      })
    }
    const source = parseTerrainSource(json)
    const layout = terrainLayout(source)
    const deps: Record<string, SourceDependency> = {}
    const lists = sourceDependencies(source)
    for (const [kind, paths] of Object.entries(lists)) {
      for (const path of paths) {
        const dep = await ctx.asset(path)
        if (dep.type !== EXPECTED[kind]) {
          throw new ShardError(
            kind === 'heightmaps' ? 'terrain/heightmap-format' : 'terrain/bad-source',
            `${path} is a ${dep.type}, not a ${EXPECTED[kind]}`,
            {
              path,
              hint:
                kind === 'heightmaps'
                  ? 'Image layers and masks read Heightmaps: a 16-bit grayscale PNG with "importer": "heightmap" in its .meta (or named *.height.png), or a .r16/.r32 file.'
                  : `Point it at a ${EXPECTED[kind]}.`,
            },
          )
        }
        deps[path] = { guid: dep.guid, type: dep.type, hash: dep.hash }
      }
    }
    const fill = (r: SourceRef | null) => {
      if (r && deps[r.path]) r.guid = deps[r.path]!.guid
    }
    for (const l of source.height) {
      if (l.kind === 'noise') fill(l.noise)
      if (l.kind === 'image') fill(l.image)
    }
    for (const p of source.paint) {
      fill(p.noise?.ref ?? null)
      fill(p.mask?.ref ?? null)
    }
    fill(source.textures.albedo)
    fill(source.textures.normal)
    fill(source.textures.orm)
    const hash = await sha256Hex(
      new TextEncoder().encode(JSON.stringify({ source, deps: Object.entries(deps).sort() })),
    )
    const artifact: TerrainSourceArtifact = { format: 1, source, layout, deps, hash }
    return {
      assets: [
        {
          label: '',
          type: 'terrain/TerrainSource',
          json: artifact as unknown as JsonValue,
          dependencies: Object.keys(deps),
          info: {
            size: source.size,
            spacing: source.spacing,
            roots: layout.rootsX * layout.rootsZ,
            depth: layout.depth,
            blocks: layout.blocksX * layout.blocksZ,
            heightLayers: source.height.length,
            materialLayers: source.layers.length,
          },
        },
      ],
    }
  },
})

const num = (description: string, extra: Record<string, unknown> = {}) => ({
  type: 'number',
  description,
  ...extra,
})
const pairOf = (description: string, examples: unknown[]) => ({
  type: 'array',
  items: { type: 'number' },
  minItems: 2,
  maxItems: 2,
  description,
  examples,
})
const refOf = (description: string, example: string) => ({
  type: 'object',
  properties: { path: { type: 'string', minLength: 1 }, guid: { type: 'string' } },
  required: ['path'],
  description,
  examples: [{ path: example }],
})
const rect = {
  at: pairOf('Center of the rectangle, [x, z] metres from the terrain’s corner.', [[2048, 1800]]),
  size: pairOf('Width (along X before rotation) and depth (along Z), metres.', [[1200, 900]]),
  rotation: num('Degrees about +Y (right-handed: positive turns +X toward −Z). Default 0.', {
    examples: [20],
  }),
}
const blend = {
  enum: ['add', 'max', 'min', 'replace'],
  description:
    'How the layer combines with the height below, mixed by its falloff mask: add (default for noise), max, min, replace (default for images).',
}

/** The JSON Schema of `*.terrain.json` (written to `.shard/schemas/terrain.schema.json`). */
export function terrainJsonSchema(): Record<string, unknown> {
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'Heightfield terrain (spec 0071)',
    description:
      'A bounded landscape as an ordered stack of height layers (noise, heightmap images, splines that flatten, raise or carve) and paint layers (material weights by height, slope, noise, masks and splines). `shard import` (or the first run) bakes it into page packs in .shard/cache/terrain; a Terrain component on an entity draws, streams and collides with it. Coordinates are metres from the terrain’s corner, x along +X and z along +Z.',
    type: 'object',
    properties: {
      $schema: { type: 'string' },
      size: pairOf(
        'Size [x, z] in metres, 256 m – 64 km a side, a whole number of roots: 64 × spacing × 2^k, at most 64 roots (2048, 4096, 16384 at 1 m spacing).',
        [[4096, 4096]],
      ),
      spacing: num('Leaf sample spacing (m), 0.25–4. 1 for most open worlds, 0.5 for detail.', {
        minimum: 0.25,
        maximum: 4,
        examples: [1],
      }),
      paintSpacing: num('Control (paint) sample spacing: 1, 2 (default) or 4 times spacing.', {
        examples: [2],
      }),
      heightRange: pairOf(
        'Lowest and highest height the bake stores (m); heights are 16-bit over it, so a 1 km range keeps 1.5 cm steps. A baked height outside it clips and is reported as terrain/out-of-range.',
        [[-200, 800]],
      ),
      seed: num('Mixed into every noise layer and mask: the same graphs make another terrain.', {
        examples: [7],
      }),
      splines: {
        type: 'object',
        description:
          'Named splines (Catmull-Rom through their points): height layers flatten, raise or carve along them; paint layers paint along them; scatter can avoid them.',
        additionalProperties: {
          type: 'object',
          properties: {
            points: {
              type: 'array',
              minItems: 2,
              items: {
                type: 'array',
                minItems: 3,
                maxItems: 3,
                items: [
                  { type: 'number' },
                  { anyOf: [{ type: 'number' }, { const: 'ground' }] },
                  { type: 'number' },
                ],
              },
              description:
                '[x, y, z] points; y may be "ground": the height of the layers below the one using the spline at that point.',
              examples: [
                [
                  [120, 'ground', 300],
                  [900, 40, 420],
                ],
              ],
            },
            width: num('Full width of the flat part (m).', { examples: [8] }),
            falloff: num('Metres beyond the width over which a height layer using it fades out.', {
              examples: [14],
            }),
          },
          required: ['points', 'width'],
          additionalProperties: false,
        },
      },
      height: {
        type: 'array',
        description: 'Height layers, applied in order from 0 m.',
        items: {
          oneOf: [
            {
              type: 'object',
              description:
                'Noise (0041) over the whole terrain, or over a rectangle with a falloff.',
              properties: {
                noise: refOf('A noise graph.', 'noise/hills.noise.json'),
                scale: num('Metres per unit of the graph’s output (default 1).', {
                  examples: [260],
                }),
                offset: num('Metres added after scaling (default 0).'),
                blend,
                falloff: num('Metres outside the rectangle over which it fades (default 0).'),
                ...rect,
              },
              required: ['noise'],
              additionalProperties: false,
            },
            {
              type: 'object',
              description: 'A heightmap image over a rotated rectangle.',
              properties: {
                image: refOf(
                  'A Heightmap (16-bit grayscale PNG, .r16 or .r32).',
                  'terrain/valley.height.png',
                ),
                range: pairOf('Metres the image’s 0 and 1 map to.', [[0, 140]]),
                blend,
                falloff: num('Metres outside the rectangle over which it fades (default 0).', {
                  examples: [80],
                }),
                ...rect,
              },
              required: ['image', 'at', 'size', 'range'],
              additionalProperties: false,
            },
            {
              type: 'object',
              description:
                'A spline: flatten to its height, raise up to it (embankments), or carve down to it (cuttings, river beds).',
              properties: {
                spline: { type: 'string', description: 'A name from "splines".' },
                mode: { enum: ['flatten', 'raise', 'carve'], description: 'Default flatten.' },
                offset: num('Metres added to the spline’s height (a carve’s depth: −2).'),
                falloff: num('Overrides the spline’s falloff for this layer.'),
              },
              required: ['spline'],
              additionalProperties: false,
            },
          ],
        },
      },
      layers: {
        type: 'array',
        maxItems: 32,
        description: 'Material layers (at most 32), sampled from the texture arrays.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Paint layers name it.', examples: ['grass'] },
            albedo: num('Layer of the albedo array (default: this layer’s index).'),
            normal: num('Layer of the normal array (default: albedo’s).'),
            orm: num('Layer of the ORM array (default: albedo’s).'),
            scale: num('Metres one texture repeat covers (default 4).', { examples: [4] }),
            triplanar: {
              type: 'boolean',
              description: 'Projected from three axes where the slope passes 45° (rock on cliffs).',
            },
          },
          required: ['name'],
          additionalProperties: false,
        },
      },
      textures: {
        type: 'object',
        description: 'Texture arrays (0043’s *.texarray.json), one layer per surface texture.',
        properties: {
          albedo: refOf('Albedo array.', 'terrain/albedo.texarray.json'),
          normal: refOf('Normal map array.', 'terrain/normal.texarray.json'),
          orm: refOf('Occlusion / roughness / metallic array.', 'terrain/orm.texarray.json'),
        },
        additionalProperties: false,
      },
      paint: {
        type: 'array',
        description:
          'Paint layers, in order: the first is the base; each later one paints its layer over what’s below where all its masks pass.',
        items: {
          type: 'object',
          properties: {
            layer: { type: 'string', description: 'A material layer’s name.' },
            height: pairOf('Where the height is in [min, max] (m).', [[600, 2000]]),
            slope: pairOf('Where the slope is in [min, max] degrees (0 flat, 90 a cliff).', [
              [32, 90],
            ]),
            noise: {
              ...refOf('A noise graph above a threshold.', 'noise/patches.noise.json'),
              properties: {
                path: { type: 'string' },
                guid: { type: 'string' },
                above: num('Paints where the graph is above this (default 0).', {
                  examples: [0.2],
                }),
              },
            },
            mask: {
              type: 'object',
              description: 'A Heightmap over a rectangle: paints by its value (0–1).',
              properties: {
                path: { type: 'string' },
                guid: { type: 'string' },
                ...rect,
              },
              required: ['path', 'at', 'size'],
            },
            spline: {
              type: 'string',
              description: 'Paints along a spline, out to half its width.',
            },
            blend: num(
              'Softens the masks’ edges: metres for height, masks and splines, degrees for slope (default 0, hard).',
              { examples: [6] },
            ),
          },
          required: ['layer'],
          additionalProperties: false,
        },
      },
    },
    required: ['size', 'spacing', 'heightRange', 'height'],
    additionalProperties: false,
  }
}

export const terrainSchema = defineAssetSchema('terrain.schema.json', terrainJsonSchema)
