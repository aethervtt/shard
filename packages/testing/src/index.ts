import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { findComponent, ShardError } from '@shard/core'
import type { GpuContext } from '@shard/gpu'
import { createNodeGpuContext } from '@shard/gpu/node'
import { type HeadlessProject, openProject } from '@shard/node'
import type { JsonRpcResponse } from '@shard/protocol'
import type { App } from '@shard/runtime'
import { findEntityByPath } from '@shard/scene'
import { afterAll, test as vitestTest } from 'vitest'

export { describe, expect } from 'vitest'

type Json = Record<string, any> // biome-ignore lint/suspicious/noExplicitAny: test-facing JSON

/**
 * The game under test: a headless app with the project loaded, fixed timestep, fixed seed. Every
 * method maps to a protocol call, so tests exercise the same surface agents use.
 */
export class Game {
  readonly project: HeadlessProject
  private nextId = 1

  constructor(project: HeadlessProject) {
    this.project = project
  }

  get app(): App {
    return this.project.app
  }

  /** Any protocol method. Throws the ShardError on failure. */
  async call<T = Json>(method: string, params?: unknown): Promise<T> {
    const response = (await this.project.server.handle({
      jsonrpc: '2.0',
      id: this.nextId++,
      method,
      params,
    })) as JsonRpcResponse
    if (response.error) {
      const data = response.error.data as
        | { code?: string; path?: string; hint?: string }
        | undefined
      throw new ShardError(data?.code ?? 'testing/protocol', response.error.message, {
        path: data?.path,
        hint: data?.hint,
      })
    }
    return response.result as T
  }

  /** Loads a scene file, replacing the start scene. */
  async load(scenePath: string): Promise<void> {
    for (const id of await this.call<{ scenes: string[] }>('app.describe').then((d) => d.scenes)) {
      if (id !== scenePath)
        await this.call('scene.load', { json: { version: 1, entities: [] }, id })
    }
    await this.call('scene.load', { file: scenePath, id: scenePath })
  }

  /** Runs `frames` frames at the fixed timestep. */
  async step(frames = 1): Promise<void> {
    await this.call('time.step', { frames })
  }

  /** A component's JSON value on the entity at `path` (or id), as the protocol would report it. */
  get(entity: string | number, component: string): Json {
    const world = this.app.world
    const e = this.resolve(entity)
    const def = findComponent(component)
    if (!def || !world.has(e, def)) throw missing(entity, component)
    return def.serialize(world.get(e, def))
  }

  /** All components of an entity as JSON. */
  async entity(entity: string | number): Promise<Json> {
    return (await this.call<{ components: Json }>('entity.get', { entity })).components
  }

  async patch(entity: string | number, components: Json): Promise<void> {
    await this.call('entity.patch', { entity, components })
  }

  readonly input = {
    /** Holds an action (`"<map>.<action>"`) or key (`"KeyW"`) until released. */
    hold: (name: string) => this.inject(name, true),
    release: (name: string) => this.inject(name, false),
    /** Press for one frame. */
    press: async (name: string) => {
      this.inject(name, true)
      await this.step(1)
      this.inject(name, false)
    },
  }

  /** Saves a PNG of a camera (default: the first) to `.shard/test-results/<name>`. Returns the path. */
  async screenshot(
    name: string,
    options: { camera?: string; width?: number; height?: number } = {},
  ): Promise<string> {
    const shot = await this.call<{ data: string }>('render.capture', options)
    const dir = join(this.project.root, '.shard', 'test-results')
    await mkdir(dir, { recursive: true })
    const file = join(dir, name)
    await writeFile(file, Buffer.from(shot.data, 'base64'))
    return file
  }

  private inject(name: string, pressed: boolean): void {
    const isAction = name.includes('.')
    void this.call('input.inject', isAction ? { action: name, pressed } : { key: name, pressed })
  }

  private resolve(entity: string | number): number {
    const world = this.app.world
    const e = typeof entity === 'number' ? entity : findEntityByPath(world, entity)
    if (e === undefined || !world.isAlive(e)) {
      throw new ShardError('testing/unknown-entity', `No entity ${JSON.stringify(entity)}`, {
        hint: 'Use a scene path like "ship/camera" or an entity id.',
      })
    }
    return e
  }
}

function missing(entity: string | number, component: string): ShardError {
  return new ShardError(
    'testing/missing-component',
    `${JSON.stringify(entity)} has no "${component}"`,
  )
}

let sharedGpu: GpuContext | undefined
const open: HeadlessProject[] = []

afterAll(() => {
  for (const p of open.splice(0)) p.close()
  sharedGpu?.destroy()
  sharedGpu = undefined
})

/** Where the project is: `SHARD_PROJECT_ROOT` (set by `shard test`) or the working directory. */
function projectRoot(): string {
  return process.env.SHARD_PROJECT_ROOT ?? process.cwd()
}

/** A gameplay test. Each test gets a fresh game; the GPU is shared across a file. */
export function test(
  name: string,
  fn: (ctx: { game: Game }) => Promise<void> | void,
  timeout = 30_000,
): void {
  vitestTest(
    name,
    async () => {
      sharedGpu ??= await createNodeGpuContext()
      const project = await openProject({
        root: projectRoot(),
        // Test files import project modules directly; the game must use the same instances.
        code: 'source',
        gpu: sharedGpu,
        width: 320,
        height: 180,
      })
      open.push(project)
      await fn({ game: new Game(project) })
    },
    timeout,
  )
}
