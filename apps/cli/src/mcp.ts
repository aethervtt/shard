import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { allComponents, findComponent, type JsonSchema, ShardError } from '@shard/core'
import { listScenes } from '@shard/node'
import { METHODS } from '@shard/protocol'
import type { ProtocolTarget } from './hub'

export interface McpContext {
  /** The app tools talk to right now (attached live app, or the headless project). */
  target(): ProtocolTarget
  /** Project folder, for resources and tests. */
  root: string
  /** Runs `shard test --json`; returns its parsed output. */
  runTests(pattern?: string): Promise<unknown>
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

/** The protocol method's parameter schema, as an MCP input schema. */
function paramsSchema(method: string, overrides: Record<string, JsonSchema> = {}): JsonSchema {
  const def = METHODS.find((m) => m.name === method)!
  const schema = def.params.jsonSchema()
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
    'step',
    'time.step',
    'Pauses and runs exactly N frames at the fixed timestep (60 per second). Use it to let physics, input, and animation play out before looking again.',
  ),
  forward('pause', 'time.pause', 'Pauses the game.'),
  forward('resume', 'time.resume', 'Resumes a paused game.'),
  {
    name: 'screenshot',
    description:
      'Renders the current state (without advancing time) and returns the image. Defaults to the first camera at 768×432. Pass "camera" (an entity path like "ship/camera") to pick a view.',
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
    'recent_errors',
    'errors.recent',
    'Recent errors (systems, GPU, shaders) with code, path, and hint. Check this when something looks wrong.',
  ),
  forward('logs', 'log.tail', 'Recent log entries.'),
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
