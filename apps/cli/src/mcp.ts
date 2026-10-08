import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { animationMethods } from '@aethervtt/shard-animation'
import { allImporters, findImporter } from '@aethervtt/shard-assets'
import { audioMethods } from '@aethervtt/shard-audio'
import { allComponents, findComponent, type JsonSchema, ShardError } from '@aethervtt/shard-core'
import { navMethods } from '@aethervtt/shard-nav'
import { listScenes } from '@aethervtt/shard-node'
import { noiseMethods } from '@aethervtt/shard-noise'
import { physicsMethods } from '@aethervtt/shard-physics'
import { procgenMethods } from '@aethervtt/shard-procgen'
import { ProjectMethodParams } from '@aethervtt/shard-project'
import { METHODS } from '@aethervtt/shard-protocol'
import { atmosphereMethods } from '@aethervtt/shard-render'
import { saveMethods } from '@aethervtt/shard-save'
import { scatterMethods } from '@aethervtt/shard-scatter'
import { tilemapMethods } from '@aethervtt/shard-sprite'
import { terrainMethods } from '@aethervtt/shard-terrain'
import { localeMethods } from '@aethervtt/shard-text'
import { uiMethods } from '@aethervtt/shard-ui'
import { metricsMethods } from '@aethervtt/shard-verify/metrics'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import type { ProtocolTarget } from './hub'

export interface McpContext {
  /** The app tools talk to right now (attached live app, or the headless project). */
  target(): ProtocolTarget
  /** Project folder, for resources and tests. */
  root: string
  /** Runs `shard test --json`; returns its parsed output. */
  runTests(pattern?: string): Promise<unknown>
  /** Runs `shard check`; returns diagnostics. */
  typecheck?(): Promise<unknown>
}

type ToolResult = {
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]
  isError?: boolean
}

interface Tool {
  name: string
  description: string
  inputSchema: JsonSchema
  run(ctx: McpContext, args: Record<string, unknown>): Promise<ToolResult>
}

const text = (value: unknown): ToolResult => ({
  content: [
    { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
  ],
})

/** Methods engine plugins add to the app (served when the plugin is enabled). */
const PLUGIN_METHODS = [
  ...physicsMethods,
  ...animationMethods,
  ...audioMethods,
  ...uiMethods,
  ...navMethods,
  ...saveMethods,
  ...localeMethods,
  ...noiseMethods,
  ...procgenMethods,
  ...terrainMethods,
  ...scatterMethods,
  ...atmosphereMethods,
  ...metricsMethods,
  ...tilemapMethods,
]

/** The protocol method's parameter schema, as an MCP input schema. */
function paramsSchema(method: string, overrides: Record<string, JsonSchema> = {}): JsonSchema {
  const params =
    METHODS.find((m) => m.name === method)?.params ??
    PLUGIN_METHODS.find((m) => m.name === method)?.params ??
    ProjectMethodParams[method as keyof typeof ProjectMethodParams]
  const schema = params.jsonSchema()
  delete schema.$schema
  delete schema.title
  delete schema['x-version']
  schema.properties = { ...(schema.properties as object), ...overrides }
  return schema
}

/** A tool that forwards to one protocol method and returns its result as JSON text. */
function forward(
  name: string,
  method: string,
  description: string,
  overrides?: Record<string, JsonSchema>,
): Tool {
  return {
    name,
    description,
    inputSchema: paramsSchema(method, overrides),
    run: async (ctx, args) => text(await ctx.target().request(method, args)),
  }
}

const inputName: JsonSchema = {
  type: 'string',
  description:
    'An action as "<map>.<action>" (e.g. "star-explorer/Controls.thrust") or a key code (e.g. "KeyW", "Space").',
}

function inject(ctx: McpContext, name: string, pressed: boolean) {
  return ctx
    .target()
    .request(
      'input.inject',
      name.includes('.') ? { action: name, pressed } : { key: name, pressed },
    )
}

/** Reload count last seen by `step`, per target, to tell the agent when its edit took effect. */
const seenReloads = new Map<string, number>()

export const TOOLS: Tool[] = [
  {
    name: 'describe_project',
    description:
      'Start here. Returns the running app: plugins, systems in order, loaded scenes, entity count, renderer and input state, which app you are talking to (headless or a live Studio/browser), and the scene files on disk.',
    inputSchema: { type: 'object', properties: {} },
    run: async (ctx) =>
      text({
        target: ctx.target().name,
        sceneFiles: await listScenes(ctx.root),
        app: await ctx.target().request('app.describe'),
      }),
  },
  forward(
    'get_schema',
    'schema.get',
    'The JSON Schema of one component: fields, types, ranges, units, presets, and descriptions. Read it before writing a component in a scene or patch. Example: { "name": "render/Camera3d" }.',
  ),
  forward(
    'validate_scene',
    'scene.validate',
    'Checks a scene without loading it. Returns every error with a JSON pointer ("path") and a hint; fix them all, then validate again. Pass "file" (e.g. "scenes/main.scene.json") or inline "json".',
  ),
  forward(
    'load_scene',
    'scene.load',
    'Loads a scene into the running game (replacing a loaded scene with the same id; the id defaults to the file path). Returns entity paths → ids. Validate first.',
  ),
  forward(
    'save_scene',
    'scene.save',
    'Serializes a loaded scene back to its file format; fields you did not change keep their authored form. Set "write": true to write the file.',
  ),
  forward(
    'query_entities',
    'world.query',
    'Finds entities by components. Example: { "with": ["render/Mesh3d"], "fields": ["core/Transform"], "limit": 20 }. Returns ids, scene paths, and component values.',
  ),
  forward(
    'get_entity',
    'entity.get',
    'All components of one entity as JSON. "entity" is an id or a scene path like "ship/camera". In a world with grids it also returns worldPosition64: the exact position relative to the floating origin\'s cell.',
  ),
  forward(
    'spawn_entity',
    'entity.spawn',
    'Spawns an entity from component JSON, the same shape as scene files. Example: { "components": { "core/Transform": { "translation": [0, 2, 0] }, "render/Mesh3d": { "mesh": { "path": "procedural:sphere?radius=1" } } } }.',
  ),
  forward(
    'patch_entity',
    'entity.patch',
    'Changes component fields on an entity; unspecified fields keep their values, null removes a component. All values are validated first; nothing changes if any is invalid. Example: { "entity": "ship", "components": { "core/Transform": { "translation": [0, 5, 0] } } }. In a large world, { "entity": "moon", "position64": [3.8e8, 0, 0], "grid": "system" } places it exactly (cell and translation computed for you).',
  ),
  forward('despawn_entity', 'entity.despawn', 'Despawns an entity and (by default) its children.'),
  forward(
    'spawn_prefab',
    'prefab.spawn',
    'Spawns a prefab instance into the running game. Returns the root id and its generated entities by path. Example: { "prefab": "prefabs/ship.prefab.json", "transform": { "translation": [0, 5, 0] }, "overrides": { "Exhaust": { "particles/ParticleSystem": { "timeScale": 2 } } } }.',
  ),
  forward(
    'prefab_overrides',
    'prefab.overrides',
    'What an instance changed from its prefab (or model), as the overrides a scene save would write. Patch generated entities (e.g. "player-ship/Exhaust") with patch_entity, then check here before save_scene.',
  ),
  {
    name: 'step',
    description:
      'Pauses and runs exactly N frames at the fixed timestep (60 per second). Use it to let physics, input, and animation play out before looking again. The result says if your code changes were reloaded since the last step.',
    inputSchema: paramsSchema('time.step'),
    run: async (ctx, args) => {
      const target = ctx.target()
      const result = (await target.request('time.step', args)) as Record<string, unknown>
      const status = (await target.request('project.status').catch(() => undefined)) as
        | { reloads: number; error?: { message: string; source?: string } }
        | undefined
      if (status) {
        const seen = seenReloads.get(target.name)
        if (seen !== undefined && status.reloads > seen) {
          result.note = `Project code reloaded since the last step (${status.reloads - seen} reload(s)); these frames ran the new code.`
        }
        if (status.error) {
          result.codeError = `Your last code change didn't load, so the previous code is still running: ${status.error.message}${status.error.source ? ` (${status.error.source})` : ''}`
        }
        seenReloads.set(target.name, status.reloads)
      }
      return text(result)
    },
  },
  forward('pause', 'time.pause', 'Pauses the game.'),
  forward('resume', 'time.resume', 'Resumes a paused game.'),
  {
    name: 'screenshot',
    description:
      'Renders the current state (without advancing time) and returns the image. Defaults to the first camera at 768×432. Pass "camera" (an entity path like "ship/camera") to pick a view, and "overlays": ["bounds", "labels"] to draw outlines and scene paths onto this image, so you can tell which blob is which entity.',
    inputSchema: paramsSchema('render.capture', {
      width: { type: 'integer', minimum: 16, maximum: 2048, default: 768 },
      height: { type: 'integer', minimum: 16, maximum: 2048, default: 432 },
    }),
    run: async (ctx, args) => {
      const shot = await ctx
        .target()
        .request<{ data: string; width: number; height: number }>('render.capture', {
          width: 768,
          height: 432,
          ...args,
        })
      return {
        content: [
          { type: 'image', data: shot.data, mimeType: 'image/png' },
          { type: 'text', text: `${shot.width}×${shot.height}` },
        ],
      }
    },
  },
  forward(
    'pick',
    'render.pick',
    'The entity under a pixel of the last screenshot (x, y from its top left): scene path, entity id, world position, normal, and distance. null if nothing is there. Example: { "x": 384, "y": 200 }.',
  ),
  forward(
    'raycast',
    'world.raycast',
    'Casts a ray through the scene on the CPU and returns what it hits, nearest first (entity, path, position, normal, distance). Example: { "origin": [0, 10, 0], "direction": [0, -1, 0] } finds the ground under a point.',
  ),
  forward(
    'debug_overlays',
    'debug.overlays',
    'Keeps debug overlays on in every frame: bounds, lights (ranges and cones), cameras (other cameras\' frustums), cascades (shadow cascades), normals, axes, labels (scene paths). Pass the full set; [] turns them off. "filter": "ship/" limits them to one subtree.',
  ),
  forward(
    'list_gizmos',
    'debug.gizmos',
    'What gizmos and overlays drew last frame, as data: line segments and labels with positions and colors. Use it to check debug drawing from your own systems.',
  ),
  {
    name: 'press',
    description: 'Presses an action or key for one frame (press, step 1 frame, release).',
    inputSchema: { type: 'object', properties: { name: inputName }, required: ['name'] },
    run: async (ctx, args) => {
      await inject(ctx, args.name as string, true)
      await ctx.target().request('time.step', { frames: 1 })
      await inject(ctx, args.name as string, false)
      return text({ pressed: args.name })
    },
  },
  {
    name: 'hold',
    description: 'Holds an action or key down until `release`. Then `step` frames to let it act.',
    inputSchema: { type: 'object', properties: { name: inputName }, required: ['name'] },
    run: async (ctx, args) => text(await inject(ctx, args.name as string, true)),
  },
  {
    name: 'release',
    description: 'Releases an action or key held with `hold`.',
    inputSchema: { type: 'object', properties: { name: inputName }, required: ['name'] },
    run: async (ctx, args) => text(await inject(ctx, args.name as string, false)),
  },
  forward(
    'simulate_gestures',
    'input.simulate',
    'Plays pointer gestures (drag, pinch, wheel, tap, wait) in CSS pixels, a step per frame: drives camera controls and object drags. Then `step` the frames it returns.',
  ),
  forward(
    'record_input',
    'input.record',
    'Starts ("start") or stops ("stop") recording input; stop returns the recording.',
  ),
  forward(
    'replay_input',
    'input.replay',
    'Replays a recording from `record_input`, reproducing the same run.',
  ),
  {
    name: 'run_tests',
    description:
      "Runs the project's gameplay tests (tests/*.test.ts) headless. Returns passed/failed counts and each failure's message.",
    inputSchema: {
      type: 'object',
      properties: { pattern: { type: 'string', description: 'Only tests whose file matches.' } },
    },
    run: async (ctx, args) => text(await ctx.runTests(args.pattern as string | undefined)),
  },
  forward(
    'list_assets',
    'asset.list',
    'Lists assets in the project: path, type (Mesh, Material, Texture, Scene…), and state. Filter with "type", "prefix" (e.g. "assets/ships/"), or "state" ("failed" finds broken imports).',
  ),
  forward(
    'get_asset',
    'asset.get',
    'Everything about one asset: type, state, importer settings, sub-assets (a .glb lists its meshes, materials, scenes), facts such as vertex counts and bounds, dependencies, dependents, warnings, and the last error. Example: { "asset": "assets/ship.glb" }.',
  ),
  forward(
    'reimport_asset',
    'asset.import',
    'Re-imports an asset, optionally changing its import settings (saved to its .meta). Example: fix a centimeter-scale model with { "asset": "assets/ship.glb", "settings": { "scale": 0.01 } }. Omit "asset" to import every new or changed file. Settings schemas: shard://schemas/importers/<importer>.',
  ),
  forward(
    'move_asset',
    'asset.move',
    'Moves or renames an asset file and its .meta, and rewrites references to it in scenes. Use this instead of moving files by hand, which breaks references. Example: { "from": "assets/ship.glb", "to": "assets/ships/scout.glb" }.',
  ),
  {
    name: 'preview_asset',
    description:
      'Shows an asset as an image: a texture, a material on a sphere, a mesh or model framed from its bounds, or a noise graph in grayscale. Use it to look at a model before placing it, or at a material after changing it. Example: { "asset": "assets/ship.glb#Scene" }.',
    inputSchema: paramsSchema('asset.preview'),
    run: async (ctx, args) => {
      const shot = await ctx
        .target()
        .request<{ data: string; width: number; height: number }>('asset.preview', args)
      return {
        content: [
          { type: 'image', data: shot.data, mimeType: 'image/png' },
          { type: 'text', text: `${args.asset} (${shot.width}×${shot.height})` },
        ],
      }
    },
  },
  forward(
    'run_generator',
    'procgen.run',
    'Runs a generator (or finds its cached output) and summarizes it: output type, cache key and whether it was a hit, time, vertex and triangle counts and bounds (meshes), size (textures), entities by component (entities), warnings. The output is an asset at the returned "path" (procedural:…), usable as a handle. Example: { "generator": "star-explorer/Rock", "params": { "radius": 2 }, "seed": 3 }.',
  ),
  {
    name: 'preview_generator',
    description:
      'Shows a generator output: a mesh in neutral studio light from a three-quarter view, a texture as is, entities framed on their bounds. With "seeds" ("1-9", "1,5,9", or [1, 5, 9]) it is a labelled contact sheet, one cell per seed: the main loop for tuning a generator. Change one param, preview nine seeds, compare. A *.scatter.json path instead shows the set scattered on a 64 m patch, from above and at eye level. Example: { "generator": "star-explorer/Rock", "seeds": "1-9", "params": { "roughness": 0.6 } }, or { "generator": "assets/scatter/forest.scatter.json" }.',
    inputSchema: paramsSchema('procgen.preview'),
    run: async (ctx, args) => {
      const shot = await ctx.target().request<{
        data: string
        width: number
        height: number
        generator?: string
        asset?: string
        keys?: string[]
      }>('procgen.preview', args)
      return {
        content: [
          { type: 'image', data: shot.data, mimeType: 'image/png' },
          {
            type: 'text',
            text: `${shot.generator ?? shot.asset}${args.seeds ? ` seeds ${JSON.stringify(args.seeds)}` : ''} (${shot.width}×${shot.height})`,
          },
        ],
      }
    },
  },
  forward(
    'describe_terrain',
    'terrain.describe',
    'Planet terrain as data: chunks selected per depth, partial chunks waiting for children, requests in flight, pool use, collider chunks and their anchors, vertex spacing at the finest and collider depths, and the height, biome, and slope under the camera. Problems (radius too large, a climate graph missing temperature or moisture) show here too. Use it to check LOD and colliders while flying around.',
  ),
  forward(
    'sample_terrain',
    'terrain.sample',
    'The surface of a planet at up to 4096 points, from the same CPU noise colliders use: height above the radius, underwater and water depth, slope, temperature, moisture, and biome weights. Points are directions from the center or [lat, lon] in degrees. Example: { "latlon": [[0, 0], [80, 20]] } to compare the equator with the arctic.',
  ),
  forward(
    'describe_scatter',
    'scatter.describe',
    'Scatter (rocks, trees, grass) as data, per surface (a planet or a ScatterSurface mesh): ready or what it waits for, problems (an unknown rule in avoid, a density its spacing cannot fit), and per rule its kind and range; for props the chunks in range, placements and spawned entities; for foliage the GPU chunks and instances visible and casting shadows. Use it to check a ScatterSet after editing it.',
  ),
  forward(
    'sample_scatter',
    'scatter.sample',
    'Prop placements near a point from the CPU placement, spawned or not: rule, item, position, distance, scale, and whether the game removed it. Ask what is near the landing pad and move the pad. Example: { "entity": "landing-pad", "radius": 10 }, or on a planet { "latlon": [12, 40], "radius": 30 }.',
  ),
  forward(
    'sample_atmosphere',
    'atmosphere.sample',
    'Sky radiance (cd/m²) and transmittance through a planet’s atmosphere toward a direction, from the renderer’s model on the CPU: is the sky still blue at 40 km, how dark is it at dusk, how much of the star field shows through. Defaults to the first camera’s position and its primary atmosphere. Example: { "direction": [0, 1, 0] }, or { "position": [0, 40000, 0], "direction": [0, 1, 0] }.',
  ),
  forward(
    'tilemap_read',
    'tilemap.read',
    'A tilemap layer\'s cells as text rows: space-separated runs of name[:flags][*count], "." for empty, flags fx/fy/r90 joined by +. Tiles are palette names (atlas regions). Read the whole layer by chunk, one chunk, or a rect. Example: { "asset": "assets/dungeon.tilemap.json", "layer": "ground", "rect": { "x": 0, "y": 0, "w": 8, "h": 4 } }.',
  ),
  forward(
    'tilemap_edit',
    'tilemap.edit',
    'Edits a tilemap layer by tile name: cells, a filled rect, or a chunk\'s rows (as tilemap_read returns them). The live game updates at once, re-uploading only the touched chunks; save: true also writes the file in its own encoding (a one-tile edit is a one-line diff). Example: { "asset": "assets/dungeon.tilemap.json", "layer": "ground", "cells": [{ "x": 3, "y": 2, "tile": "water" }], "save": true }.',
  ),
  {
    name: 'terrain_map',
    description:
      'An equirectangular image of a whole planet: "biomes" colors land by its dominant biome (shaded by slope), "height" dark lowlands to white peaks; water is blue, darker when deeper. One image answers "are there continents, oceans, and polar caps". Example: { "mode": "biomes", "size": 512 }.',
    inputSchema: paramsSchema('terrain.map'),
    run: async (ctx, args) => {
      const map = await ctx
        .target()
        .request<{ data: string; width: number; height: number }>('terrain.map', args)
      return {
        content: [
          { type: 'image', data: map.data, mimeType: 'image/png' },
          { type: 'text', text: `${args.mode ?? 'biomes'} map (${map.width}×${map.height})` },
        ],
      }
    },
  },
  forward(
    'describe_generators',
    'procgen.describe',
    'Every generator in the project and engine: params (a JSON Schema with units, ranges, defaults), output type, version, and code hash. Also the output cache (records, bytes, limit), run and hit counts, jobs running now, and how many workers run jobs.',
  ),
  {
    name: 'preview_noise',
    description:
      'Shows a noise graph (*.noise.json) in grayscale, black at its minimum and white at its maximum, on a plane or on a sphere. `node` shows one intermediate node on its own (a mask, a layer). Example: { "graph": "assets/noise/planet.noise.json", "domain": "sphere", "node": "mask" }.',
    inputSchema: {
      type: 'object',
      properties: {
        graph: { type: 'string', description: 'NoiseGraph asset path or guid.' },
        domain: { enum: ['plane', 'sphere'], default: 'plane' },
        seed: { type: 'integer', minimum: 0, default: 0 },
        size: { type: 'integer', minimum: 16, maximum: 2048, default: 256 },
        node: { type: 'string', description: 'Preview this node instead of the output.' },
      },
      required: ['graph'],
    },
    run: async (ctx, args) => {
      const { graph, ...options } = args
      const size = (options.size as number | undefined) ?? 256
      const shot = await ctx
        .target()
        .request<{ data: string; width: number; height: number }>('asset.preview', {
          asset: graph,
          width: size,
          height: size,
          options,
        })
      return {
        content: [
          { type: 'image', data: shot.data, mimeType: 'image/png' },
          {
            type: 'text',
            text: `${graph}${options.node ? ` (${options.node})` : ''} (${shot.width}×${shot.height})`,
          },
        ],
      }
    },
  },
  forward(
    'sample_noise',
    'noise.sample',
    'Exact values of a noise graph at up to 4096 points. `graph` is an asset path or inline graph JSON (try an edit before saving it); `origin` makes points offsets from an f64 origin (precise on a planet\'s surface). Example: { "graph": "assets/noise/planet.noise.json", "seed": 7, "points": [[0, 0, 0], [0.5, 0, 0]] }.',
  ),
  forward(
    'noise_stats',
    'noise.stats',
    'Summarizes a noise graph over a plane or sphere: min, max, mean, stdDev, a histogram, and the area fraction below each threshold. Use it to check coverage numerically, e.g. { "graph": "assets/noise/planet.noise.json", "domain": "sphere", "thresholds": [0] } for how much of the planet is under sea level.',
  ),
  forward(
    'measure_text',
    'text.measure',
    'Measures a string in a font without drawing it: width, height, and wrapped lines. Example: { "font": "assets/fonts/Inter.ttf", "value": "Scanner 7", "size": 0.5, "maxWidth": 3 }.',
  ),
  forward(
    'project_status',
    'project.status',
    'The project code as the running game sees it: reload count, the last reload report (migrated and orphaned components, systems added, removed, or changed), and the last build or reload error with its file:line:col. Check it after editing scripts.',
  ),
  forward(
    'reload_project',
    'project.reload',
    'Rebuilds the project scripts and hot reloads them now, keeping the world. Saving a file does this automatically; call it to force a reload or to see the report.',
  ),
  {
    name: 'typecheck',
    description:
      'Type-checks the project scripts (shard check) and returns every error as { file, line, column, code, message }. Reloads never wait for type checks, so run this after editing code.',
    inputSchema: { type: 'object', properties: {} },
    run: async (ctx) => {
      if (!ctx.typecheck)
        throw new ShardError('cli/unavailable', 'Type checking is not available here')
      return text(await ctx.typecheck())
    },
  },
  forward(
    'recent_errors',
    'errors.recent',
    'Recent errors (systems, GPU, shaders) with code, path, and hint. Check this when something looks wrong.',
  ),
  forward('logs', 'log.tail', 'Recent log entries.'),
  forward(
    'physics_raycast',
    'physics.raycast',
    'Casts a ray against physics colliders (physics3d or physics2d plugin): the nearest hit, or every hit with "all", each with collider path, body path, point, normal, and distance. Example: straight down to find the ground under "ship": { "origin": [0, 50, 0], "direction": [0, -1, 0] }.',
  ),
  forward(
    'physics_overlap',
    'physics.overlap',
    'Colliders at a point, or overlapping a ball, cuboid, or capsule at a position. Use it to check what a trigger volume or a spawn point touches.',
  ),
  forward(
    'physics_describe',
    'physics.describe',
    'Physics state: bodies by kind, how many sleep, and how many are parked beyond the physics range (large worlds), colliders by shape, joints, contact pairs, colliders waiting for a mesh, the range radius, and the last step time.',
  ),
  forward(
    'metrics_record',
    'metrics.record',
    'A performance record (spec 0062) of the running app: cold start, first usable frame, patch-to-frame latency (p50/p95 of app.trace), frame-time p50/p95/p99 and GPU p95, long tasks, GPU memory by category, and downloads, over the window since metrics_reset (at most 30 s). Needs a live app (shard dev, attached). Measure after a change the way the capture scripts do: metrics_reset, exercise the scene, then metrics_record.',
  ),
  forward(
    'metrics_reset',
    'metrics.reset',
    'Starts a new measurement window for metrics_record: frame times, traces and long tasks so far stop counting.',
  ),
  forward(
    'animation_describe',
    'animation.describe',
    "What an AnimationPlayer is doing (animation plugin): each layer's clip, time, duration, weight, loop, blend, mask, and fade, how many targets bound, channels whose target is missing (a wrong path), and this frame's root motion. With an Animator (animation graph): each graph layer's current state, transition in progress and its progress, time in state, blend-space weights, and the parameter values. Without an entity: every player.",
  ),
  forward(
    'audio_describe',
    'audio.describe',
    "What's playing (audio plugin): the backend and whether its context is suspended, the listener, buses (volume, mute, final gain, ducking), and every voice: clip, source entity, bus, state (active, virtual, pending), gain after bus and distance, pan (-1 left, +1 right), distance, clip time, pitch, priority. An agent can't hear: this is how to check a sound plays, where, and how loud.",
  ),
  forward(
    'ui_describe',
    'ui.describe',
    "The UI as data (ui plugin): every node's path, rect [x, y, width, height] in its root's pixels, visibility, text, style, widget state (hovered, pressed, focused, disabled, on, value), anchor state (on-screen, clamped, hidden), and scroll; the focused and hovered nodes; this frame's layout and upload counts. Read the HUD here; use screenshots only to check how it looks.",
  ),
  forward(
    'ui_click',
    'ui.click',
    'Clicks a UiButton or UiToggle by path (e.g. "hud/menu/play", or a unique suffix like "play"): sends ui/UiClick and flips a toggle, exactly as a real click, with no pixel coordinates. Step a frame for systems to react.',
  ),
  forward(
    'ui_focus',
    'ui.focus',
    'Gives keyboard/gamepad focus to a widget by path (null clears it). Gameplay action maps pause while a node has focus.',
  ),
  forward(
    'audio_log',
    'audio.log',
    'Voices started, stopped (ended, stopped, stolen, removed), and dropped over the voice limit, by frame, with clip, entity, bus, position, gain, and pan. Pass since (a frame) for recent ones.',
  ),
  forward(
    'save_game',
    'save.write',
    'Saves the game to a slot: what changed in each loaded scene (field by field), runtime-spawned entities (prefab instances by reference), persisted resources, RNG streams, and time. Pass json to write an edited save instead (read one with save.read, change a value, write it back: a test fixture).',
  ),
  forward(
    'load_game',
    'save.load',
    'Loads a slot (or a save json): scenes reload from their current files, then the saved changes, spawned entities, resources, RNG streams, and time apply. Warnings list what no longer matches the scenes (save/stale-entity).',
  ),
  forward(
    'nav_path',
    'nav.path',
    'A path between two world points (nav plugin), on the NavGrid or NavMesh containing from: status (complete; partial: ends at the closest reachable point; none), corners, and length. Checks a level is connected without running an agent.',
  ),
  forward(
    'nav_describe',
    'nav.describe',
    'Navigation as data (nav plugin): each NavGrid (source, size, walkable cells, problem), each NavMesh (tiles, polygons, bounds, the last bake: tiles built by Recast vs loaded from the cache), sources skipped and why, and every NavAgent: status (idle, moving, arrived, unreachable), remaining distance, velocity, destination or target, and its route. Turn on the navmesh overlay to see it.',
  ),
  forward(
    'nav_bake',
    'nav.bake',
    'Rebakes every NavMesh now and saves the tiles to .shard/cache/nav (save: false to skip; force: true rebuilds every tile). Reports tiles built and loaded from the cache.',
  ),
]

/** An MCP server exposing Shard's tools and resources for one project. */
export function createMcpServer(ctx: McpContext): Server {
  const server = new Server(
    { name: 'shard', version: '0.0.0' },
    { capabilities: { tools: {}, resources: {} } },
  )
  const byName = new Map(TOOLS.map((t) => [t.name, t]))

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as never,
    })),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = byName.get(request.params.name)
    if (!tool)
      return {
        content: [{ type: 'text', text: `Unknown tool "${request.params.name}"` }],
        isError: true,
      }
    try {
      return (await tool.run(
        ctx,
        (request.params.arguments ?? {}) as Record<string, unknown>,
      )) as never
    } catch (err) {
      const e =
        err instanceof ShardError ? err.toJSON() : { code: 'cli/unexpected', message: String(err) }
      return {
        content: [{ type: 'text', text: JSON.stringify(e, null, 2) }],
        isError: true,
      } as never
    }
  })

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: 'shard://docs/agents',
        name: 'Project agent docs (AGENTS.md + component catalog)',
        mimeType: 'text/markdown',
      },
      ...(await listScenes(ctx.root)).map((path) => ({
        uri: `shard://scenes/${path}`,
        name: path,
        mimeType: 'application/json',
      })),
      ...allImporters().map((i) => ({
        uri: `shard://schemas/importers/${i.name}`,
        name: `${i.name} import settings (${i.extensions.join(', ')})`,
        mimeType: 'application/schema+json',
      })),
      ...allComponents()
        .filter((d) => d.serializable && !d.name.startsWith('test/'))
        .map((d) => ({
          uri: `shard://schemas/${d.name}`,
          name: `${d.name} schema`,
          mimeType: 'application/schema+json',
        })),
    ],
  }))

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri
    const read = (file: string) => readFile(join(ctx.root, file), 'utf8').catch(() => '')
    let body: string
    let mimeType = 'application/json'
    if (uri === 'shard://docs/agents') {
      body = `${await read('AGENTS.md')}\n\n${await read('.agents/components.md')}`
      mimeType = 'text/markdown'
    } else if (uri.startsWith('shard://scenes/')) {
      body = await read(uri.slice('shard://scenes/'.length))
    } else if (uri.startsWith('shard://schemas/importers/')) {
      const importer = findImporter(uri.slice('shard://schemas/importers/'.length))
      if (!importer) throw new ShardError('cli/unknown-resource', `No resource ${uri}`)
      body = JSON.stringify(importer.settings.jsonSchema(), null, 2)
    } else if (uri.startsWith('shard://schemas/')) {
      const def = findComponent(uri.slice('shard://schemas/'.length))
      if (!def) throw new ShardError('cli/unknown-resource', `No resource ${uri}`)
      body = JSON.stringify(def.jsonSchema(), null, 2)
    } else {
      throw new ShardError('cli/unknown-resource', `No resource ${uri}`)
    }
    return { contents: [{ uri, mimeType, text: body }] }
  })

  return server
}
