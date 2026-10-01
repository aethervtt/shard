import { ShardError } from '@aethervtt/shard-core'
import type { GpuContext } from '@aethervtt/shard-gpu'
import type { FileChangeEvent, Platform } from '@aethervtt/shard-platform'
import type { RetargetedBinding } from './baseline/rewrite'
import { BASELINE_REWRITE_VERSION, collectData, type DataDeclaration } from './data-marks'
import { applyHooks, findHooks } from './hooks'

/**
 * WESL, the linker, loads on the first variant a bake doesn't cover. An app whose variants are all
 * baked never downloads it.
 */
type Wesl = typeof import('wesl')
let wesl: Promise<Wesl> | undefined
const loadWesl = (): Promise<Wesl> => {
  wesl ??= import('wesl')
  return wesl
}

export interface LinkRequest {
  /** Module with the entry points, e.g. `shard::pbr::main` or `project::water`. */
  root: string
  /** Conditions for `@if(...)`. */
  defines?: Readonly<Record<string, boolean>>
  /** Override modules, in order; the last one wins per hook. */
  overrides?: readonly string[]
  /** Names what the variant is for in errors, e.g. `material my-game/Lava`. */
  label?: string
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
  /** Baseline variants (0064): the bindings the rewrite retargeted, for the engine's layouts. */
  bindings?: readonly RetargetedBinding[]
}

/** One linked variant, for `ShaderLibrary.preload`. */
export interface BakedShader {
  /** The variant: root module, defines, overrides. */
  key: string
  /** Of every module the variant links; a changed module makes the entry stale. */
  hash: string
  code: string
}

/** Linked variants saved from a run (`ShaderLibrary.bake()`), loaded with `preload`. */
export interface ShaderBake {
  version: 1
  shaders: BakedShader[]
}

interface ModuleVariant {
  code: string
  module: GPUShaderModule
  linked: LinkedShader
  /** The GPU device generation the module was created on. */
  generation: number
}

interface VariantState {
  /** The last module that compiled cleanly; what callers get. */
  good: ModuleVariant | undefined
  /** Set while linking/compiling, so a variant is only rebuilt once per change. */
  pending: string | undefined
  /** Library version this variant was last built against. */
  version: number
  /** What it was last requested with, so a change can rebuild it before the next request. */
  gpu: GpuContext | undefined
  request: LinkRequest | undefined
  /** Why the latest build failed, while it has; cleared by the next clean compile (0061). */
  failed: ShardError | undefined
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
  /** Module sources as they link: `@data` marks stripped (0064). */
  private readonly sources = new Map<string, string>()
  /** Each module's `@data` declarations, for baseline variants. */
  private readonly data = new Map<string, DataDeclaration[]>()
  /** Where each module came from, for error messages (a file path, or the module path). */
  private readonly origins = new Map<string, string>()
  private readonly linkCache = new Map<string, Promise<LinkedShader>>()
  private readonly variants = new Map<string, VariantState>()
  private readonly listeners = new Set<(paths: readonly string[]) => void>()
  private version = 0

  /** Bumps whenever a module is registered or changes: what renderers compare to retry failures. */
  get revision(): number {
    return this.version
  }
  private readonly preloaded = new Map<string, BakedShader>()
  /** Every variant linked or served from the bake, for `bake()`. */
  private readonly used = new Map<string, BakedShader>()
  /** How many variants the bake didn't cover and WESL linked. */
  linked = 0

  /**
   * Serves these variants without linking, as long as the modules they came from haven't changed.
   * A stale or missing variant is linked as usual (loading WESL if it hasn't loaded yet).
   */
  preload(bake: ShaderBake): void {
    if (bake.version !== 1) {
      throw new ShardError('shader/bake-version', `Unknown shader bake version ${bake.version}`, {
        hint: 'Bake again with this version of Shard.',
      })
    }
    for (const entry of bake.shaders) this.preloaded.set(entry.key, entry)
    this.linkCache.clear()
  }

  /**
   * The variants this library has used so far, to save and `preload` next time. Bake after a run
   * that draws everything the app draws: a variant that wasn't used isn't in it.
   */
  bake(): ShaderBake {
    const shaders = [...this.used.values()].sort((a, b) => (a.key < b.key ? -1 : 1))
    return { version: 1, shaders }
  }

  /** Adds or replaces a module. `origin` is shown in errors (e.g. `shaders/toon.wesl`). */
  register(path: string, source: string, origin?: string): void {
    if (!PATH.test(path)) {
      throw new ShardError('shader/invalid-path', `Invalid shader module path "${path}"`, {
        hint: 'Use lowercase `package::dir::name`, e.g. `project::water`.',
      })
    }
    const { code, data } = collectData(source, path)
    if (this.sources.get(path) === code && sameData(this.data.get(path), data)) return
    this.sources.set(path, code)
    if (data.length > 0) this.data.set(path, data)
    else this.data.delete(path)
    this.origins.set(path, origin ?? path)
    this.version++
    this.linkCache.clear()
    for (const listener of this.listeners) listener([path])
    this.scheduleRebuild()
  }

  private rebuildScheduled = false

  /**
   * After a change, rebuilds every variant already in use at once (in a microtask, so a batch of
   * registrations rebuilds once), instead of waiting for its next `module()` call: an edited
   * shader has usually compiled by the frame that draws it.
   */
  private scheduleRebuild(): void {
    if (this.rebuildScheduled || this.variants.size === 0) return
    this.rebuildScheduled = true
    queueMicrotask(() => {
      this.rebuildScheduled = false
      for (const s of this.variants.values()) {
        if (s.gpu && s.request && s.version !== this.version && s.pending === undefined) {
          this.rebuild(s.gpu, s.request, s)
        }
      }
    })
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

  /**
   * Registers every `.wesl`/`.wgsl` file under `dir` (recursively) as `pkg::path::name`. Hosts load a
   * project's `shaders/` folder with it, then `watch` for edits.
   */
  async loadDir(platform: Platform, dir: string, pkg: string): Promise<string[]> {
    const list = platform.fs.list
    if (!list) return []
    const loaded: string[] = []
    const prefix = dir.replace(/\/+$/, '')
    const walk = async (rel: string): Promise<void> => {
      for (const entry of await list.call(platform.fs, rel ? `${prefix}/${rel}` : prefix)) {
        const path = rel ? `${rel}/${entry.name}` : entry.name
        if (entry.kind === 'dir') await walk(path)
        else if (/\.(wesl|wgsl)$/.test(entry.name)) {
          const module = `${pkg}::${path
            .replace(/\.(wesl|wgsl)$/, '')
            .split('/')
            .join('::')}`
          const file = `${prefix}/${path}`
          this.register(module, await platform.fs.readText(file), file)
          loaded.push(module)
        }
      }
    }
    await walk('')
    return loaded
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
    // The baseline tier (0064) links every variant with BASELINE and rewrites it; the full tier
    // asks for exactly what it always has.
    if (gpu.tier === 'baseline' && !request.defines?.BASELINE) {
      request = { ...request, defines: { ...request.defines, BASELINE: true } }
    }
    const key = variantKey(request)
    let state = this.variants.get(key)
    if (!state) {
      state = { good: undefined, pending: undefined, version: -1, gpu, request, failed: undefined }
      this.variants.set(key, state)
    }
    const s = state
    s.gpu = gpu
    if (s.version !== this.version && s.pending === undefined) this.rebuild(gpu, request, s)
    // After device loss the old module belongs to a dead device; rebuild it from the linked code.
    if (s.good && s.good.generation !== gpu.generation) {
      s.good = { ...s.good, module: moduleFor(gpu, s.good.linked), generation: gpu.generation }
    }
    return s.good?.module
  }

  private rebuild(gpu: GpuContext, request: LinkRequest, s: VariantState): void {
    s.version = this.version
    s.pending = 'linking'
    this.link(request).then(
      async (linked) => {
        if (s.good?.code !== linked.code) {
          s.pending = linked.code
          const error = await compile(gpu, linked)
          if (error) {
            s.failed = labelled(error, request.label)
            gpu.reportError(s.failed)
          } else {
            s.failed = undefined
            s.good = {
              code: linked.code,
              module: moduleFor(gpu, linked),
              linked,
              generation: gpu.generation,
            }
          }
        } else s.failed = undefined
        s.pending = undefined
      },
      (err: unknown) => {
        s.failed = labelled(
          err instanceof ShardError ? err : new ShardError('shader/link', String(err)),
          request.label,
        )
        gpu.reportError(s.failed)
        s.pending = undefined
      },
    )
  }

  /**
   * Why a variant has no module to give: its code failed to link or compile, and no earlier version
   * compiled either. Undefined while it compiles, once it has a module, and for unknown variants.
   * Renderers draw with a fallback then instead of skipping the draw forever (0061).
   */
  failure(request: LinkRequest, gpu?: GpuContext): ShardError | undefined {
    if (gpu?.tier === 'baseline' && !request.defines?.BASELINE) {
      request = { ...request, defines: { ...request.defines, BASELINE: true } }
    }
    const s = this.variants.get(variantKey(request))
    return s && !s.good && s.pending === undefined ? s.failed : undefined
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

  /** Every module a variant links: its root's imports, and the overrides'. */
  private closureOf(request: LinkRequest): string[] {
    const imports = (p: string) => importsOf(this.sources.get(p) ?? '')
    const paths = new Set<string>()
    for (const root of [request.root, ...(request.overrides ?? [])])
      for (const p of closure(root, imports)) paths.add(p)
    return [...paths].sort()
  }

  /**
   * Of the source of every module a variant links. A baseline variant's also covers its `@data`
   * declarations and the rewrite's version, which change its code and not its modules' text.
   */
  private hashOf(request: LinkRequest): string {
    const paths = this.closureOf(request)
    let a = 0x811c9dc5
    let b = 0x9747b28c
    const baseline = request.defines?.BASELINE
      ? `baseline ${BASELINE_REWRITE_VERSION} ${JSON.stringify(paths.map((p) => this.data.get(p) ?? []))}\n`
      : ''
    for (const path of [...paths, ...(baseline ? [''] : [])]) {
      const text = path ? `${path}\n${this.sources.get(path) ?? ''}\n` : baseline
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i)
        a = Math.imul(a ^ c, 0x01000193)
        b = Math.imul(b ^ c, 0x5bd1e995)
      }
    }
    return `${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`
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

    const hash = this.hashOf(request)
    const baked = this.preloaded.get(key)
    if (baked && baked.hash === hash) {
      this.used.set(key, baked)
      return { key, code: baked.code, locate: () => undefined }
    }

    const { link } = await loadWesl()
    this.linked++
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

    let linked: Awaited<ReturnType<Wesl['link']>>
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

    const origins = this.origins
    const locate = (offset: number): SourceLocation | undefined => {
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
    }
    if (!request.defines?.BASELINE) {
      const code = linked.dest
      this.used.set(key, { key, hash, code })
      return { key, code, locate }
    }
    // Baseline (0064): retarget engine data and what GLSL ES 3.00 lacks. Loaded only here.
    const { rewriteForBaseline } = await import('./baseline/rewrite')
    const data = this.closureOf(request).flatMap((p) => this.data.get(p) ?? [])
    const rewritten = rewriteForBaseline(linked.dest, data, locate, request.label)
    this.used.set(key, { key, hash, code: rewritten.code })
    return {
      key,
      code: rewritten.code,
      locate: (offset) => locate(rewritten.toLinked(offset)),
      bindings: rewritten.bindings,
    }
  }
}

function sameData(
  a: readonly DataDeclaration[] | undefined,
  b: readonly DataDeclaration[],
): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b)
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
  let message = (err instanceof Error ? err.message : String(err)).split('\n')[0]!
  let loc = (err as { weslLocation?: { file: string; line: number; column: number } }).weslLocation
  // Parse errors carry the location in the message instead: `./pkg/file.wesl:2:14 error: ...`.
  const prefix = /^(\.\/\S+?):(\d+):(\d+)\s+error:\s*(.*)$/.exec(message)
  if (!loc && prefix) {
    loc = { file: prefix[1]!, line: Number(prefix[2]), column: Number(prefix[3]) }
    message = prefix[4]!
  }
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

/** Prefixes an error's message with what the shader was for. */
function labelled(error: ShardError, label: string | undefined): ShardError {
  if (!label) return error
  return new ShardError(error.code, `${label}: ${error.message}`, {
    path: error.path,
    hint: error.hint,
  })
}

function variantKey(request: LinkRequest): string {
  const defines = Object.entries(request.defines ?? {})
    .filter(([, on]) => on)
    .map(([name]) => name)
    .sort()
  return `${request.root}|${defines.join(',')}|${(request.overrides ?? []).join(',')}`
}

/** The modules a source imports, conditional imports (`@if(LIT) import …`) included. */
function importsOf(source: string): string[] {
  const out: string[] = []
  for (const m of source.matchAll(/^\s*(?:@\w+\s*\([^)]*\)\s*)*import\s+([^;]+);/gm)) {
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
