import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ChildOf, ShardError, type World } from '@shard/core'
import type { GpuContext } from '@shard/gpu'
import { createNodeGpuContext } from '@shard/gpu/node'
import type { Platform } from '@shard/platform'
import { createNodePlatform } from '@shard/platform-node'
import { buildApp, type ErrorCode, loadProject, type ManifestValue } from '@shard/project'
import { createProtocolServer, type ProtocolServer } from '@shard/protocol'
import { OffscreenTarget } from '@shard/render'
import type { App, Plugin } from '@shard/runtime'
import { type LoadedSceneHandle, loadScene } from '@shard/scene'

export { createNodePlatform } from '@shard/platform-node'

export interface OpenProjectOptions {
  /** Project folder (with shard.json). */
  root: string
  /** Headless render size; defaults to the manifest's window. */
  width?: number
  height?: number
  /** Load the manifest's start scene (default true). */
  loadStartScene?: boolean
  /** Share a GPU context across projects (tests); otherwise one is created. */
  gpu?: GpuContext
  /** Overrides the manifest's `seed`. */
  seed?: number
}

export interface HeadlessProject {
  root: string
  manifest: ManifestValue
  platform: Platform
  app: App
  server: ProtocolServer
  gpu: GpuContext
  target: OffscreenTarget
  scene: LoadedSceneHandle | undefined
  close(): void
}

/** Imports the project plugin (default export of `entry`). */
export async function importProjectPlugin(root: string, manifest: ManifestValue): Promise<Plugin> {
  const file = resolve(root, manifest.entry)
  let mod: { default?: Plugin }
  try {
    mod = await import(pathToFileURL(file).href)
  } catch (cause) {
    throw new ShardError(
      'project/entry-failed',
      `Couldn't load ${manifest.entry}: ${(cause as Error).message}`,
      {
        path: manifest.entry,
        hint: 'The entry must be a module whose default export is defineProject({...}).',
        cause,
      },
    )
  }
  const plugin = mod.default
  if (!plugin || typeof plugin.build !== 'function' || typeof plugin.name !== 'string') {
    throw new ShardError(
      'project/entry-invalid',
      `${manifest.entry} has no project plugin as its default export`,
      {
        path: manifest.entry,
        hint: 'End the file with `export default project`, where project = defineProject({...}).',
      },
    )
  }
  return plugin
}

/** Opens a project headless: manifest, project code, Dawn GPU, offscreen target, protocol server. */
export async function openProject(options: OpenProjectOptions): Promise<HeadlessProject> {
  const root = resolve(options.root)
  const platform = createNodePlatform({ root })
  const loaded = (await loadProject(platform)).manifest
  const manifest = options.seed === undefined ? loaded : { ...loaded, seed: options.seed }
  const project = await importProjectPlugin(root, manifest)
  const ownGpu = !options.gpu
  const gpu = options.gpu ?? (await createNodeGpuContext({ features: ['timestamp-query'] }))
  const target = new OffscreenTarget(gpu, {
    label: 'headless',
    width: options.width ?? manifest.window.width,
    height: options.height ?? manifest.window.height,
  })
  const app = buildApp({ manifest, project, gpu, target })
  await app.init()
  let scene: LoadedSceneHandle | undefined
  if (options.loadStartScene ?? true) {
    const json = JSON.parse(await platform.fs.readText(manifest.startScene))
    scene = loadScene(app.world, json, { id: manifest.startScene })
  }
  const server = createProtocolServer(app, { frames: 'manual', platform })
  return {
    root,
    manifest,
    platform,
    app,
    server,
    gpu,
    target,
    scene,
    close() {
      server.close()
      target.destroy()
      if (ownGpu) gpu.destroy()
    },
  }
}

/** Scene files under `scenes/`, as project-relative paths. */
export async function listScenes(root: string): Promise<string[]> {
  const dir = join(resolve(root), 'scenes')
  const entries = await readdir(dir, { recursive: true }).catch(() => [] as string[])
  return entries
    .filter((f) => f.endsWith('.scene.json'))
    .map((f) => relative(resolve(root), join(dir, f)).split('\\').join('/'))
    .sort()
}

/**
 * A stable hash of every entity's serializable components (and parents). Equal worlds hash equal,
 * so determinism checks compare one string.
 */
export function worldHash(world: World): string {
  const rows: string[] = []
  for (const table of world.allTables()) {
    for (let row = 0; row < table.count; row++) {
      const entity = table.entities[row]!
      const values = table.components
        .filter((c) => c.serializable || c === ChildOf)
        .map((c) => [c.name, c.serialize(table.readComponent(c, row))])
      rows.push(JSON.stringify([entity, values]))
    }
  }
  return createHash('sha256').update(rows.sort().join('\n')).digest('hex')
}

/**
 * Error codes the engine can raise, scanned from the engine packages' sources (with the hint written
 * next to each). Feeds `.agents/errors.md`.
 */
export async function collectErrorCodes(): Promise<ErrorCode[]> {
  const require = createRequire(import.meta.url)
  // @shard/core resolves to packages/core/src/index.ts; the packages dir is three levels up.
  const packagesDir = dirname(dirname(dirname(require.resolve('@shard/core'))))
  const found = new Map<string, ErrorCode>()
  const pkgs = await readdir(packagesDir).catch(() => [] as string[])
  for (const pkg of pkgs) {
    const src = join(packagesDir, pkg, 'src')
    const files = await readdir(src, { recursive: true }).catch(() => [] as string[])
    for (const file of files) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue
      const text = await readFile(join(src, file), 'utf8')
      const re = /new ShardError\(\s*['"]([a-z0-9-]+\/[a-z0-9-]+)['"]/g
      for (let m = re.exec(text); m; m = re.exec(text)) {
        const code = m[1]!
        const window = text.slice(m.index, m.index + 700)
        const next = window.indexOf('new ShardError', 10)
        const hint = /hint:\s*(['"`])((?:(?!\1).)+)\1/.exec(
          next === -1 ? window : window.slice(0, next),
        )?.[2]
        if (!found.has(code) || (!found.get(code)!.hint && hint)) {
          found.set(code, {
            code,
            source: `@shard/${pkg}`,
            ...(hint && !hint.includes('${') ? { hint } : {}),
          })
        }
      }
    }
  }
  return [...found.values()]
}
