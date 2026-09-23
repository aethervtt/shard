import { ShardError } from '@shard/core'
import type { GpuContext } from '@shard/gpu'
import type { FileChangeEvent, Platform } from '@shard/platform'
import { link } from 'wesl'
import { applyHooks, findHooks } from './hooks'

export interface LinkRequest {
  /** Module with the entry points, e.g. `shard::pbr::main` or `project::water`. */
  root: string
  /** Conditions for `@if(...)`. */
  defines?: Readonly<Record<string, boolean>>
  /** Override modules, in order; the last one wins per hook. */
  overrides?: readonly string[]
}

export interface SourceLocation {
  module: string
  line: number
  column: number
}

export interface LinkedShader {
  key: string
  code: string
  /** Maps a character offset in `code` back to the module that produced it. */
  locate(offset: number): SourceLocation | undefined
}

interface ModuleVariant {
  code: string
  module: GPUShaderModule
}

interface VariantState {
  /** The last module that compiled cleanly; what callers get. */
  good: ModuleVariant | undefined
  /** Set while linking/compiling, so a variant is only rebuilt once per change. */
  pending: string | undefined
  /** Library version this variant was last built against. */
  version: number
}

const PATH = /^[a-z_][a-z0-9_]*(::[a-z_][a-z0-9_]*)+$/

/** `shard::pbr::lighting` → package `shard`, file `./pbr/lighting.wesl`. */
function splitPath(path: string): { pkg: string; file: string } {
  const [pkg, ...rest] = path.split('::')
  return { pkg: pkg!, file: `./${rest.join('/')}.wesl` }
}

function lineColumn(text: string, offset: number): { line: number; column: number } {
  let line = 1
  let lineStart = 0
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      line++
      lineStart = i + 1
    }
  }
  return { line, column: offset - lineStart + 1 }
}

/**
 * Shader modules by path (`package::dir::file`), linked on demand with WESL. Engine shaders live
 * under `shard::`, plugins under their own package, a project's `shaders/` folder under `project::`.
 */
export class ShaderLibrary {
  private readonly sources = new Map<string, string>()
  /** Where each module came from, for error messages (a file path, or the module path). */
  private readonly origins = new Map<string, string>()
  private readonly linkCache = new Map<string, Promise<LinkedShader>>()
  private readonly variants = new Map<string, VariantState>()
  private readonly listeners = new Set<(paths: readonly string[]) => void>()
  private version = 0

  /** Adds or replaces a module. `origin` is shown in errors (e.g. `shaders/toon.wesl`). */
  register(path: string, source: string, origin?: string): void {
    if (!PATH.test(path)) {
      throw new ShardError('shader/invalid-path', `Invalid shader module path "${path}"`, {
        hint: 'Use lowercase `package::dir::name`, e.g. `project::water`.',
      })
    }
    if (this.sources.get(path) === source) return
    this.sources.set(path, source)
    this.origins.set(path, origin ?? path)
    this.version++
    this.linkCache.clear()
    for (const listener of this.listeners) listener([path])
  }

  has(path: string): boolean {
    return this.sources.has(path)
  }

  /** Called with the changed module paths whenever a module is registered or replaced. */
  onChange(listener: (paths: readonly string[]) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Reloads modules from files when they change. `dir` maps to `pkg`: with `('shaders', 'project')`,
   * `shaders/water/foam.wesl` is `project::water::foam`.
   */
  async watch(platform: Platform, dir: string, pkg: string): Promise<() => void> {
    if (!platform.fs.watch) {
      throw new ShardError(
        'shader/watch-unsupported',
        `The ${platform.name} platform can't watch files`,
      )
    }
    const prefix = dir.replace(/\/+$/, '')
    return platform.fs.watch(prefix, (event: FileChangeEvent) => {
      if (event.kind === 'remove' || !/\.(wesl|wgsl)$/.test(event.path)) return
      const rel = event.path.startsWith(`${prefix}/`)
        ? event.path.slice(prefix.length + 1)
        : event.path
      const path = `${pkg}::${rel
        .replace(/\.(wesl|wgsl)$/, '')
        .split('/')
        .join('::')}`
      void platform.fs.readText(event.path).then((text) => this.register(path, text, event.path))
    })
  }

  /** Links a variant. Results are cached until any module changes. */
  link(request: LinkRequest): Promise<LinkedShader> {
    const key = variantKey(request)
    let result = this.linkCache.get(key)
    if (!result) {
      result = this.doLink(request, key)
      this.linkCache.set(key, result)
      result.catch(() => this.linkCache.delete(key))
    }
    return result
  }

  /**
   * A compiled shader module for a variant, or undefined while the first version compiles. After an
   * edit, keeps returning the previous module until the new code compiles cleanly; if it doesn't,
   * the error is reported through the GPU context and the old module stays in use.
   */
  module(gpu: GpuContext, request: LinkRequest): GPUShaderModule | undefined {
    const key = variantKey(request)
    let state = this.variants.get(key)
    if (!state) {
      state = { good: undefined, pending: undefined, version: -1 }
      this.variants.set(key, state)
    }
    const s = state
    if (s.version !== this.version && s.pending === undefined) {
      s.version = this.version
      s.pending = 'linking'
      this.link(request).then(
        async (linked) => {
          if (s.good?.code !== linked.code) {
            s.pending = linked.code
            const error = await compile(gpu, linked)
            if (error) gpu.reportError(error)
            else s.good = { code: linked.code, module: moduleFor(gpu, linked) }
          }
          s.pending = undefined
        },
        (err: unknown) => {
          gpu.reportError(
            err instanceof ShardError ? err : new ShardError('shader/link', String(err)),
          )
          s.pending = undefined
        },
      )
    }
    return s.good?.module
  }

  /** Waits until every variant requested through `module()` has finished compiling. */
  async whenIdle(): Promise<void> {
    for (let i = 0; i < 200; i++) {
      if (![...this.variants.values()].some((v) => v.pending !== undefined)) return
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

  /** Module graph and hooks, for agents. */
  describe(root?: string) {
    const modules = [...this.sources.keys()].sort()
    const imports = (path: string) => importsOf(this.sources.get(path) ?? '')
    const reachable = root ? [...closure(root, imports)] : modules
    return {
      modules: reachable,
      imports: Object.fromEntries(reachable.map((m) => [m, imports(m)])),
      hooks: Object.fromEntries(
        reachable
          .map((m) => [m, [...findHooks(this.sources.get(m) ?? '').keys()]] as const)
          .filter(([, h]) => h.length > 0),
      ),
      defines: [...new Set(reachable.flatMap((m) => definesOf(this.sources.get(m) ?? '')))].sort(),
    }
  }

  private async doLink(request: LinkRequest, key: string): Promise<LinkedShader> {
    const overrides = request.overrides ?? []
    for (const path of [request.root, ...overrides]) {
      if (!this.sources.has(path)) {
        throw new ShardError(
          'shader/link-unknown-module',
          `Shader module "${path}" is not registered`,
          {
            hint: `Registered modules: ${[...this.sources.keys()].sort().join(', ') || 'none'}.`,
          },
        )
      }
    }
    // WESL resolves imports lazily and ignores unused unknown ones; check them all up front.
    for (const path of closure(request.root, (p) => importsOf(this.sources.get(p) ?? ''))) {
      if (!this.sources.has(path)) {
        const importer = [...this.sources].find(([, src]) => importsOf(src).includes(path))?.[0]
        throw new ShardError('shader/link-unknown-module', `Unknown shader module "${path}"`, {
          path: importer ? this.origins.get(importer) : undefined,
          hint: 'Check the import path, or register the module.',
        })
      }
    }

    const hooked = applyHooks(this.sources, overrides)
    const root = splitPath(request.root)
    const packages = new Map<string, Record<string, string>>()
    const fileToModule = new Map<string, string>()
    for (const [path, source] of hooked) {
      const { pkg, file } = splitPath(path)
      if (!packages.has(pkg)) packages.set(pkg, {})
      packages.get(pkg)![file] = source
      fileToModule.set(`${pkg}|${file}`, path)
    }
    const libs = [...packages]
      .filter(([pkg]) => pkg !== root.pkg)
      .map(([pkg, modules]) => ({ name: pkg, edition: 'unstable_2025', modules }))

    let linked: Awaited<ReturnType<typeof link>>
    try {
      linked = await link({
        weslSrc: packages.get(root.pkg)!,
        rootModuleName: root.file,
        packageName: root.pkg,
        libs,
        conditions: { ...request.defines },
      })
    } catch (err) {
      throw linkError(
        err,
        (file) => {
          // WESL reports local files as `./x.wesl` and library files as `./<pkg>/x.wesl`.
          const lib = /^\.\/([a-z_][a-z0-9_]*)\/(.*)$/.exec(file)
          const module =
            fileToModule.get(`${root.pkg}|${file}`) ??
            (lib ? fileToModule.get(`${lib[1]}|./${lib[2]}`) : undefined)
          return module ? this.origins.get(module) : undefined
        },
        this.origins.get(request.root),
      )
    }

    const code = linked.dest
    const origins = this.origins
    return {
      key,
      code,
      locate(offset: number) {
        try {
          const pos = linked.sourceMap.destToSrc(offset)
          const srcPath = pos.src.path ?? ''
          // Library files appear as `./<pkg>/<file>`; local ones as `./<file>`.
          const match = /^\.\/([a-z_][a-z0-9_]*)\/(.*)$/.exec(srcPath)
          const module =
            fileToModule.get(`${root.pkg}|${srcPath}`) ??
            (match ? fileToModule.get(`${match[1]}|./${match[2]}`) : undefined) ??
            srcPath
          const { line, column } = lineColumn(pos.src.text, pos.position)
          return { module: origins.get(module) ?? module, line, column }
        } catch {
          return undefined
        }
      },
    }
  }
}

const moduleCache = new WeakMap<GpuContext, Map<string, GPUShaderModule>>()

/** One GPUShaderModule per distinct code string, so unchanged variants keep hitting pipeline caches. */
function moduleFor(gpu: GpuContext, linked: LinkedShader): GPUShaderModule {
  let cache = moduleCache.get(gpu)
  if (!cache || (cache as { generation?: number }).generation !== gpu.generation) {
    cache = new Map()
    ;(cache as { generation?: number }).generation = gpu.generation
    moduleCache.set(gpu, cache)
  }
  let module = cache.get(linked.code)
  if (!module) {
    module = gpu.device.createShaderModule({ label: linked.key, code: linked.code })
    cache.set(linked.code, module)
  }
  return module
}

/** WESL link errors carry `weslLocation: { file, line, column }`; point the error at the user's file. */
function linkError(
  err: unknown,
  originOf: (file: string) => string | undefined,
  fallback: string | undefined,
): ShardError {
  const message = (err instanceof Error ? err.message : String(err)).split('\n')[0]!
  const loc = (err as { weslLocation?: { file: string; line: number; column: number } })
    .weslLocation
  const origin = (loc && originOf(loc.file)) ?? fallback
  const path = origin && loc ? `${origin}:${loc.line}:${loc.column}` : origin
  return new ShardError('shader/link-unresolved', message.replace(/ in file: \S+$/, ''), { path })
}

/** Compiles and returns the first error mapped to its source, or undefined if clean. */
async function compile(gpu: GpuContext, linked: LinkedShader): Promise<ShardError | undefined> {
  // Scope the check so the generic validation error for a broken module doesn't also surface.
  gpu.device.pushErrorScope('validation')
  const probe = gpu.device.createShaderModule({ label: `${linked.key} (check)`, code: linked.code })
  void gpu.device.popErrorScope()
  const info = await probe.getCompilationInfo()
  const first = info.messages.find((m) => m.type === 'error')
  if (!first) return undefined
  const where = linked.locate(first.offset)
  const path = where ? `${where.module}:${where.line}:${where.column}` : undefined
  return new ShardError('shader/compile', `${first.message}${path ? ` (${path})` : ''}`, { path })
}

function variantKey(request: LinkRequest): string {
  const defines = Object.entries(request.defines ?? {})
    .filter(([, on]) => on)
    .map(([name]) => name)
    .sort()
  return `${request.root}|${defines.join(',')}|${(request.overrides ?? []).join(',')}`
}

function importsOf(source: string): string[] {
  const out: string[] = []
  for (const m of source.matchAll(/^\s*import\s+([^;]+);/gm)) {
    const spec = m[1]!.replace(/\s+/g, '')
    const braced = /^(.*?)::\{(.*)\}$/.exec(spec)
    if (braced) {
      for (const item of braced[2]!.split(',')) {
        const name = item.split(/as/)[0]!
        const parts = `${braced[1]}::${name}`.split('::')
        out.push(parts.slice(0, -1).join('::'))
      }
    } else {
      out.push(spec.split('::').slice(0, -1).join('::'))
    }
  }
  return [...new Set(out.filter((p) => p.includes('::') && !p.startsWith('constants')))]
}

function definesOf(source: string): string[] {
  const out: string[] = []
  for (const m of source.matchAll(/@(?:if|elif)\s*\(([^)]*)\)/g)) {
    for (const id of m[1]!.matchAll(/[A-Za-z_]\w*/g))
      if (id[0] !== 'true' && id[0] !== 'false') out.push(id[0])
  }
  return out
}

function closure(root: string, next: (path: string) => string[]): Set<string> {
  const seen = new Set<string>()
  const stack = [root]
  while (stack.length > 0) {
    const path = stack.pop()!
    if (seen.has(path)) continue
    seen.add(path)
    stack.push(...next(path))
  }
  return seen
}
