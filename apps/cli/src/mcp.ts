import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { animationMethods } from '@shard/animation'
import { allImporters, findImporter } from '@shard/assets'
import { audioMethods } from '@shard/audio'
import { allComponents, findComponent, type JsonSchema, ShardError } from '@shard/core'
import { navMethods } from '@shard/nav'
import { listScenes } from '@shard/node'
import { physicsMethods } from '@shard/physics'
import { ProjectMethodParams } from '@shard/project'
import { METHODS } from '@shard/protocol'
import { saveMethods } from '@shard/save'
import { localeMethods } from '@shard/text'
import { uiMethods } from '@shard/ui'
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
    'All components of one entity as JSON. "entity" is an id or a scene path like "ship/camera".',
  ),
  forward(
    'spawn_entity',
    'entity.spawn',
    'Spawns an entity from component JSON, the same shape as scene files. Example: { "components": { "core/Transform": { "translation": [0, 2, 0] }, "render/Mesh3d": { "mesh": { "path": "procedural:sphere?radius=1" } } } }.',
  ),
  forward(
    'patch_entity',
    'entity.patch',
    'Changes component fields on an entity; unspecified fields keep their values, null removes a component. All values are validated first; nothing changes if any is invalid. Example: { "entity": "ship", "components": { "core/Transform": { "translation": [0, 5, 0] } } }.',
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
      'Shows an asset as an image: a texture, a material on a sphere, or a mesh or model framed from its bounds. Use it to look at a model before placing it, or at a material after changing it. Example: { "asset": "assets/ship.glb#Scene" }.',
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
    'Physics state: bodies by kind and how many sleep, colliders by shape, joints, contact pairs, colliders waiting for a mesh, and the last step time.',
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
