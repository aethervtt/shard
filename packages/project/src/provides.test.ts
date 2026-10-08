import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Every package is `sideEffects: false`, so a bundler keeps a module only if something reachable
// uses it. Definitions and registrations happen when their module evaluates, so each one a package
// makes must be reachable from one of its plugins' `provides` (spec 0056). This test imports the
// packages in dependency order, diffs every registry around each import, and checks that what a
// package added is reachable from its plugins.

const packages = join(dirname(fileURLToPath(import.meta.url)), '../..')

type Mod = Record<string, unknown>
type PluginLike = { name: string; provides?: readonly object[] }

/** Each package with plugins, and how to get them from its index. */
const PLUGINS: Record<string, (m: Mod) => PluginLike[]> = {
  animation: (m) => [m.animationPlugin as PluginLike],
  audio: (m) => [(m.audioPlugin as () => PluginLike)()],
  controls: (m) => [m.controlsPlugin as PluginLike],
  dice: (m) => [(m.dicePlugin as () => PluginLike)()],
  fog: (m) => [m.fogPlugin as PluginLike],
  gltf: (m) => [m.gltfPlugin as PluginLike],
  input: (m) => [(m.inputPlugin as () => PluginLike)(), m.gesturesPlugin as PluginLike],
  nav: (m) => [m.navPlugin as PluginLike, m.navGridPlugin as PluginLike],
  noise: (m) => [m.noisePlugin as PluginLike],
  particles: (m) => [m.particlesPlugin as PluginLike],
  physics: (m) => [
    (m.physics3dPlugin as () => PluginLike)(),
    (m.physics2dPlugin as () => PluginLike)(),
  ],
  procgen: (m) => [(m.procgenPlugin as () => PluginLike)()],
  render: (m) => [
    (m.renderPlugin as (o: object) => PluginLike)({}),
    (m.forwardCorePlugin as () => PluginLike)(),
    m.environmentPlugin as PluginLike,
    m.atmospherePlugin as PluginLike,
    m.postPlugin as PluginLike,
    m.fxaaPlugin as PluginLike,
    m.gizmosPlugin as PluginLike,
    m.pickingPlugin as PluginLike,
    m.deferredPlugin as PluginLike,
    m.skinningPlugin as PluginLike,
    m.pixelPerfectPlugin as PluginLike,
    m.lensPlugin as PluginLike,
    m.cutawayPlugin as PluginLike,
    m.viewVisibilityPlugin as PluginLike,
    m.interiorPlugin as PluginLike,
    m.outlinePlugin as PluginLike,
    m.shadowCatcherPlugin as PluginLike,
    m.foliagePlugin as PluginLike,
    m.dynamicResolutionPlugin as PluginLike,
  ],
  save: (m) => [(m.savePlugin as () => PluginLike)()],
  scatter: (m) => [(m.scatterPlugin as () => PluginLike)()],
  scene: (m) => [m.ScenePlugin as PluginLike],
  sprite: (m) => [m.spritePlugin as PluginLike],
  terrain: (m) => [(m.terrainPlugin as () => PluginLike)()],
  text: (m) => [m.textPlugin as PluginLike],
  transform: (m) => [m.TransformPlugin as PluginLike],
  ui: (m) => [m.uiPlugin as PluginLike],
}

/** Plugins exported from a package's subpaths (not its index), by file under `src/`. */
const SUBPATH_PLUGINS: Record<string, Record<string, (m: Mod) => PluginLike[]>> = {
  render: { 'surface.ts': (m) => [m.surfacePlugin as PluginLike] },
}

/** Engine packages in dependency order (a package after everything it depends on). */
function dependencyOrder(): string[] {
  const deps = new Map<string, string[]>()
  const engine = ['core', 'runtime', 'assets', ...Object.keys(PLUGINS)]
  const visit = (name: string) => {
    if (deps.has(name)) return
    const manifest = JSON.parse(readFileSync(join(packages, name, 'package.json'), 'utf8'))
    const own = Object.keys(manifest.dependencies ?? {})
      .filter((d) => d.startsWith('@aethervtt/shard-'))
      .map((d) => d.slice('@aethervtt/shard-'.length))
    deps.set(name, own)
    for (const d of own) visit(d)
  }
  for (const name of engine) visit(name)
  const order: string[] = []
  const done = new Set<string>()
  const place = (name: string) => {
    if (done.has(name)) return
    done.add(name)
    for (const d of deps.get(name) ?? []) place(d)
    order.push(name)
  }
  for (const name of deps.keys()) place(name)
  return order
}

type Registries = Record<string, () => readonly unknown[]>

async function registries(): Promise<Registries> {
  const core = await import('@aethervtt/shard-core')
  const assets = await import('@aethervtt/shard-assets')
  const scene = await import('@aethervtt/shard-scene')
  const render = await import('@aethervtt/shard-render')
  const save = await import('@aethervtt/shard-save')
  return {
    components: core.allComponents,
    resources: core.allResources,
    events: core.allEvents,
    'asset types': assets.allAssetTypes,
    importers: assets.allImporters,
    'asset previews': assets.allAssetPreviews,
    'asset schemas': () => assets.allAssetSchemas().map(([, schema]) => schema),
    'import dependencies': assets.allImportDependencies,
    'asset resolvers': assets.allAssetResolvers,
    'data types': assets.allDataTypes,
    'procedural sources': scene.allProceduralSources,
    'instance kinds': scene.instanceKinds,
    overlays: render.allOverlays,
    materials: render.allMaterialTypes,
    settings: save.allSettings,
  }
}

/** What a plugin's `provides` reaches: each entry, a module's exports, and one level into them. */
function reachable(plugins: PluginLike[]): Set<unknown> {
  const out = new Set<unknown>()
  const add = (value: unknown, depth: number) => {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return
    if (out.has(value)) return
    out.add(value)
    if (depth === 0) return
    for (const v of Object.values(value as object)) add(v, depth - 1)
  }
  for (const plugin of plugins) for (const entry of plugin.provides ?? []) add(entry, 3)
  return out
}

function describeEntry(value: unknown): string {
  const v = value as { name?: string; def?: { name?: string } }
  return (
    v?.name ||
    v?.def?.name ||
    (typeof value === 'function' ? `function ${value.name || '(anonymous)'}` : '?')
  )
}

/**
 * Every source module of a package, by path. Not tests, and not worker entries (`*-worker.ts`):
 * those start serving a worker when imported, and export nothing.
 */
function modulesOf(name: string): string[] {
  const root = join(packages, name, 'src')
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.ts$/.test(entry.name) && !/(\.test|\.d|-worker)\.ts$/.test(entry.name))
        out.push(path)
    }
  }
  walk(root)
  return out
}

describe('plugins provide what their packages register (spec 0056)', () => {
  it('every registration is exported by its package and reachable from one of its plugins', async () => {
    const regs = await registries()
    // Who exports what: every module of every engine package, imported once.
    const owner = new Map<unknown, string>()
    const moduleOf = new Map<unknown, string>()
    const indexes = new Map<string, Mod>()
    for (const name of dependencyOrder()) {
      indexes.set(name, (await import(join(packages, name, 'src/index.ts'))) as Mod)
      for (const path of modulesOf(name)) {
        const mod = (await import(path)) as Mod
        for (const value of Object.values(mod)) {
          if (owner.has(value)) continue
          owner.set(value, name)
          moduleOf.set(value, path.slice(packages.length + 1))
        }
      }
    }
    /** The package that exports a registered value, or one of its parents (a material's component). */
    const ownerOf = (value: unknown): string | undefined => {
      const own = owner.get(value)
      if (own) return own
      // Two levels in: a data type's importer, and that importer's published file schema.
      const within = (parent: unknown, depth: number): boolean => {
        if (!parent || typeof parent !== 'object') return false
        for (const v of Object.values(parent)) {
          if (v === value || (depth > 1 && within(v, depth - 1))) return true
        }
        return false
      }
      for (const [exported, name] of owner) if (within(exported, 2)) return name
      const def = (value as { def?: unknown })?.def
      return def ? owner.get(def) : undefined
    }
    const reach = new Map<string, Set<unknown>>()
    for (const [name, plugins] of Object.entries(PLUGINS)) {
      const all = plugins(indexes.get(name)!)
      for (const [file, more] of Object.entries(SUBPATH_PLUGINS[name] ?? {}))
        all.push(...more((await import(join(packages, name, 'src', file))) as Mod))
      reach.set(name, reachable(all))
    }
    const missing: string[] = []
    for (const [registry, all] of Object.entries(regs)) {
      for (const value of all()) {
        const name = ownerOf(value)
        if (!name) {
          missing.push(`(not exported): ${registry} ${describeEntry(value)}`)
          continue
        }
        const r = reach.get(name)
        if (r && !r.has(value)) missing.push(`${name}: ${registry} ${describeEntry(value)}`)
      }
    }
    expect(missing.sort().join('\n')).toBe('')
  }, 120_000)
})
