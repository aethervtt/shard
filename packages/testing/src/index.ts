import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { findComponent, ShardError } from '@aethervtt/shard-core'
import { timeout as scaled } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { type HeadlessProject, openProject } from '@aethervtt/shard-node'
import type { JsonRpcResponse } from '@aethervtt/shard-protocol'
import type { App } from '@aethervtt/shard-runtime'
import { findEntityByPath } from '@aethervtt/shard-scene'
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
    /**
     * Plays pointer gestures in CSS pixels (`{ drag }`, `{ pinch }`, `{ wheel }`, `{ tap }`,
     * `{ wait }`) and steps until they're done (0060): camera controls and object drags.
     */
    gesture: async (...gestures: Json[]) => {
      const { frames } = await this.call<{ frames: number }>('input.simulate', { gestures })
      await this.step(frames)
    },
  }

  /**
   * Sounds started, stopped, and dropped (audio plugin) from frame `since`, as `audio.log` returns
   * them: `{ frame, event, clip, entity, path, bus, position, gain, pan, reason }`.
   */
  async audioLog(since = 0): Promise<Json[]> {
    return (await this.call<{ entries: Json[] }>('audio.log', { since })).entries
  }

  /** UI (ui plugin): read the HUD as data and press buttons by path, without pixel coordinates. */
  readonly ui = {
    /** `ui.describe`: every tree with rects, text, widget state, focus, and anchors. */
    describe: async (): Promise<Json> => this.call('ui.describe'),
    /** One node from `ui.describe` by scene path (or a unique suffix, like "fuel/label"). */
    node: async (path: string): Promise<Json | undefined> => {
      const d = await this.call<{ roots: { tree: Json }[] }>('ui.describe')
      const find = (n: Json): Json | undefined => {
        const p = (n as { path?: string | null }).path
        if (p === path || p?.endsWith(`/${path}`)) return n
        for (const c of ((n as { children?: Json[] }).children ?? []) as Json[]) {
          const hit = find(c)
          if (hit) return hit
        }
        return undefined
      }
      for (const r of d.roots) {
        const hit = find(r.tree)
        if (hit) return hit
      }
      return undefined
    },
    /** Clicks a button or toggle (`ui.click`); step a frame for systems to see the UiClick. */
    click: async (path: string): Promise<void> => {
      await this.call('ui.click', { entity: path })
    },
    focus: async (path: string | null): Promise<void> => {
      await this.call('ui.focus', { entity: path })
    },
  }

  /** Navigation (nav plugin): paths and agents as data. */
  readonly nav = {
    /** `nav.describe`: grids, navmeshes (tiles, last bake), and agents. */
    describe: async (): Promise<Json> => this.call('nav.describe'),
    /** `nav.path` between two world points: `{ status, length, corners }`. */
    path: async (
      from: [number, number, number],
      to: [number, number, number],
    ): Promise<{ status: 'complete' | 'partial' | 'none'; length: number; corners: number[][] }> =>
      this.call('nav.path', { from, to }),
    /** One NavAgent from `nav.describe` by scene path (or a unique suffix): status, remaining, route. */
    agent: async (path: string): Promise<Json | undefined> => {
      const d = await this.call<{ agents: { path: string | null }[] }>('nav.describe')
      return d.agents.find((a) => a.path === path || a.path?.endsWith(`/${path}`)) as
        | Json
        | undefined
    },
  }

  /** Saved games (save plugin): the same calls as save_game and load_game. */
  readonly saves = {
    /** Saves the game to a slot; returns `save.describe` of it. */
    write: async (slot: string, meta?: unknown): Promise<Json> =>
      this.call('save.write', meta === undefined ? { slot } : { slot, meta }),
    /** Loads a slot, or a save file (an edited fixture). Returns `{ scenes, spawned, warnings }`. */
    load: async (slot: string | Json): Promise<Json> =>
      this.call('save.load', typeof slot === 'string' ? { slot } : { json: slot }),
    /** A slot's save as JSON, or without a slot the game as it would save now. */
    read: async (slot?: string): Promise<Json> => this.call('save.read', slot ? { slot } : {}),
    describe: async (slot?: string): Promise<Json> =>
      this.call('save.describe', slot ? { slot } : {}),
  }

  /** Settings resources (`engine/Settings` by default): read, or set and apply at once. */
  readonly settings = {
    get: async (name = 'engine/Settings'): Promise<Json> =>
      (await this.call<{ settings: Json }>('settings.get', { name })).settings[name],
    set: async (values: Json, name = 'engine/Settings'): Promise<Json> =>
      this.call('settings.set', { name, values }),
  }

  /** Switches the locale (`"pt-BR"`); keyed text updates on the next frame. */
  async locale(tag: string): Promise<void> {
    await this.call('locale.set', { locale: tag })
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

/**
 * A gameplay test. Each test gets a fresh game; the GPU is shared across a file. `timeout` is
 * scaled like `timeout()` from test-env (5x in CI, which renders on a software GPU).
 */
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
    scaled(timeout),
  )
}

/** A gameplay test that's registered but not run. Say why next to it (and in TODO.md). */
test.skip = (name: string, _fn: (ctx: { game: Game }) => Promise<void> | void): void => {
  vitestTest.skip(name, () => {})
}
