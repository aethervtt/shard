import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { assetServer, validateDataAssets } from '@aethervtt/shard-assets'
import { ShardError, World } from '@aethervtt/shard-core'
import {
  collectErrorCodes,
  createNodePlatform,
  type HeadlessProject,
  importProjectPlugin,
  listScenes,
  type OpenProjectOptions,
  openProject,
  prepareGenerators,
  worldHash,
} from '@aethervtt/shard-node'
import {
  encodeTrack,
  recordTrack,
  type TrackContactOptions,
  trackHash,
  trackSceneFromJson,
} from '@aethervtt/shard-physics/track'
import { findNondeterminism, requireGenerator } from '@aethervtt/shard-procgen'
import {
  generateDocs,
  loadProject,
  mergeAgentsMd,
  projectTemplate,
  type TemplateName,
  validateManifest,
} from '@aethervtt/shard-project'
import { DEFAULT_HUB_PORT } from '@aethervtt/shard-protocol'
import { Gpu, Shaders } from '@aethervtt/shard-render'
import {
  loadInstanceAssets,
  loadScene,
  validatePrefab,
  validateScene,
  whenSceneReady,
} from '@aethervtt/shard-scene'
import {
  editTiles,
  readTiles,
  TextureAtlas,
  TilemapData,
  type TileRect,
  tilemapToText,
  validateTilemaps,
} from '@aethervtt/shard-sprite'
import { localizationKeysIn, validateLocalization } from '@aethervtt/shard-text'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { type BaselineReport, validateBaseline } from './baseline'
import { Hub, localTarget, type ProtocolTarget } from './hub'
import { createMcpServer } from './mcp'
import { EXIT, errorJson, formatError, type Output } from './output'
import { CAPTURES_DIR, withCpuProfile } from './profile'

export interface CommandContext {
  out: Output
  /** Project folder (default: the working directory). */
  project: string
  args: string[]
  flags: Record<string, string | boolean | undefined>
}

function flagNumber(value: unknown, fallback: number): number {
  if (value === undefined) return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) throw new ShardError('cli/usage', `Expected a number, got "${value}"`)
  return n
}

function parseSize(value: unknown): [number, number] | undefined {
  if (typeof value !== 'string') return undefined
  const m = /^(\d+)x(\d+)$/.exec(value)
  if (!m) throw new ShardError('cli/usage', `--size must look like 1280x720, got "${value}"`)
  return [Number(m[1]), Number(m[2])]
}

/** The Shard repo root if `dir` is inside it (so new projects can use workspace packages). */
function findShardRepo(dir: string): string | undefined {
  let current = resolve(dir)
  for (;;) {
    if (
      existsSync(join(current, 'pnpm-workspace.yaml')) &&
      existsSync(join(current, 'packages/core/src/index.ts'))
    )
      return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

// --- init ----------------------------------------------------------------------

export async function init({ out, args, flags }: CommandContext): Promise<number> {
  const dir = args[0]
  if (!dir)
    throw new ShardError(
      'cli/usage',
      'Usage: shard init <dir> [--template empty|explorer] [--name name]',
    )
  const target = resolve(dir)
  const template = (flags.template ?? 'explorer') as TemplateName
  if (template !== 'empty' && template !== 'explorer') {
    throw new ShardError('cli/usage', `Unknown template "${template}"`, {
      hint: 'Use "empty" or "explorer".',
    })
  }
  const name = String(flags.name ?? basename(target))
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^[^a-z]+/, '')
  const existing = await readdir(target).catch(() => [] as string[])
  if (existing.length > 0 && !flags.force) {
    throw new ShardError('cli/not-empty', `${dir} is not empty`, {
      hint: 'Pick an empty folder or pass --force.',
    })
  }
  const repo = findShardRepo(target)
  const files = projectTemplate({ name, template, engineSpec: repo ? 'workspace:*' : '0.x' })
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(target, path)), { recursive: true })
    await writeFile(join(target, path), content)
  }
  const next = ['pnpm install', 'shard docs', 'shard validate', 'shard test']
  out.result(
    {
      created: relative(process.cwd(), target) || '.',
      name,
      template,
      files: Object.keys(files),
      next,
    },
    `Created ${name} (${template}) in ${dir}.\nNext: cd ${dir} && ${next.join(' && ')}`,
  )
  return EXIT.ok
}

// --- validate --------------------------------------------------------------------

export async function validate({ out, project, flags }: CommandContext): Promise<number> {
  const platform = createNodePlatform({ root: project })
  let manifestJson: unknown
  try {
    manifestJson = JSON.parse(await platform.fs.readText('shard.json'))
  } catch (cause) {
    throw new ShardError('project/not-found', 'No readable shard.json here', {
      hint: 'Run from a project folder, pass --project <dir>, or create one with `shard init`.',
      cause,
    })
  }
  const manifestErrors = validateManifest(manifestJson)
  const report: {
    valid: boolean
    manifest: unknown[]
    assets: unknown[]
    scenes: Record<string, unknown[]>
    prefabs: Record<string, unknown[]>
    warnings: string[]
    /** Assets that would draw a fallback at runtime (0061): sources that failed to import. */
    fallbacks: string[]
    /**
     * The baseline tier (0064), with `--tier baseline` or `graphics.baseline: "required"`: the
     * scenes drawn on a compatibility-mode device, and their shaders translated for WebGL2.
     */
    baseline?: BaselineReport
  } = {
    valid: true,
    manifest: manifestErrors.map((e) => e.toJSON()),
    assets: [],
    scenes: {},
    prefabs: {},
    warnings: [],
    fallbacks: [],
  }
  if (manifestErrors.length === 0) {
    const { manifest } = await loadProject(platform)
    await importProjectPlugin(resolve(project), manifest) // defines the project's components
    await setupGenerators(project, manifest, platform)
    const world = new World()
    // Scenes reference assets by path, so the catalog has to be current first.
    const scan = await assetServer(world).configure({ platform, roots: manifest.assetRoots }).scan()
    report.assets = scan.failed.map((f) => ({ ...f.error, source: f.path }))
    for (const meta of scan.orphanedMetas) report.warnings.push(`${meta} has no source file`)
    for (const m of scan.moved)
      report.warnings.push(`${m.from} moved to ${m.to} without its .meta; references may be stale`)
    // Non-fatal import problems (an animation graph's unreachable state).
    for (const entry of assetServer(world).list()) {
      if (entry.label !== '' || !entry.source || entry.error) continue
      for (const w of assetServer(world).info(entry.guid).warnings)
        report.warnings.push(`${entry.source}${w.path ? ` ${w.path}` : ''}: ${w.message}`)
    }
    const failed = new Set(scan.failed.map((f) => f.path))
    report.fallbacks = [...failed].sort()
    // String tables against each other; keys used in scenes and prefabs are checked below.
    const strings = await validateLocalization(world)
    for (const { source, error } of strings.errors)
      report.assets.push({ ...error.toJSON(), source })
    const undefinedKeys = (json: unknown) =>
      localizationKeysIn(json)
        .filter(({ key }) => !strings.keys.has(key))
        .map(({ key, path }) =>
          new ShardError('locale/missing-key', `No string table defines "${key}"`, {
            path,
            hint:
              strings.locales.length > 0
                ? `Add it to locales/${strings.locales[0]}.strings.json (and the other locales: ${strings.locales.join(', ')}).`
                : 'Add locales/en.strings.json with { "key": "text" }.',
          }).toJSON(),
        )
    // Handles inside data files need the whole catalog, so they're checked after the scan.
    for (const { source, errors } of await validateDataAssets(world)) {
      for (const e of errors) report.assets.push({ ...e.toJSON(), source })
    }
    // Files that place things (scenes, prefabs), for checks that pair assets (tilemap and atlas).
    const placing: unknown[] = []
    // Instance overrides are checked against their prefab or model, so those load first.
    for (const entry of assetServer(world).list({ type: 'Prefab' })) {
      if (!entry.source || failed.has(entry.source)) continue // reported with the imports
      const json = JSON.parse(await platform.fs.readText(entry.source))
      placing.push(json)
      await loadInstanceAssets(world, json)
      report.prefabs[entry.source] = [
        ...validatePrefab(world, json, { id: entry.source }).map((e) => e.toJSON()),
        ...undefinedKeys(json),
      ]
    }
    for (const scene of await listScenes(project)) {
      let json: unknown
      try {
        json = JSON.parse(await platform.fs.readText(scene))
      } catch (err) {
        report.scenes[scene] = [
          { code: 'scene/invalid-json', message: (err as Error).message, path: '' },
        ]
        continue
      }
      await loadInstanceAssets(world, json)
      placing.push(json)
      report.scenes[scene] = [
        ...validateScene(world, json, { id: scene }).map((e) => e.toJSON()),
        ...undefinedKeys(json),
      ]
    }
    // Tile names against the atlas each tilemap is drawn with (0059).
    for (const { source, errors } of await validateTilemaps(world, placing)) {
      for (const e of errors) report.assets.push({ ...e.toJSON(), source })
    }
    // The baseline tier (0064): opt in on the command line, or require it in the manifest.
    const tier = flags.tier === undefined ? undefined : String(flags.tier)
    if (tier !== undefined && tier !== 'baseline' && tier !== 'full') {
      throw new ShardError('cli/usage', `--tier is baseline or full, not "${tier}"`)
    }
    if (tier === 'baseline' || (tier === undefined && manifest.graphics.baseline === 'required')) {
      report.baseline = await validateBaseline(project, await listScenes(project))
    }
  }
  const problems =
    report.manifest.length +
    report.assets.length +
    Object.values(report.scenes).reduce((n, e) => n + e.length, 0) +
    Object.values(report.prefabs).reduce((n, e) => n + e.length, 0) +
    (report.baseline?.problems.length ?? 0)
  report.valid = problems === 0
  const lines = [report.valid ? 'Valid.' : `${problems} problem(s):`]
  for (const e of report.manifest as { code: string; path?: string; message: string }[])
    lines.push(`  shard.json${e.path ?? ''}: [${e.code}] ${e.message}`)
  for (const e of report.assets as {
    code: string
    source: string
    path?: string
    message: string
    hint?: string
  }[])
    lines.push(
      `  ${e.source}${e.path && e.path !== e.source ? ` ${e.path}` : ''}: [${e.code}] ${e.message}${e.hint ? `\n      hint: ${e.hint}` : ''}`,
    )
  for (const w of report.warnings) lines.push(`  warning: ${w}`)
  for (const f of report.fallbacks)
    lines.push(
      `  fallback: ${f} draws its fallback at runtime until it imports (assets.retry reloads it)`,
    )
  for (const [scene, errors] of [
    ...Object.entries(report.prefabs),
    ...Object.entries(report.scenes),
  ]) {
    for (const e of errors as { code: string; path?: string; message: string; hint?: string }[]) {
      lines.push(
        `  ${scene}${e.path ?? ''}: [${e.code}] ${e.message}${e.hint ? `\n      hint: ${e.hint}` : ''}`,
      )
    }
  }
  if (report.baseline) {
    const b = report.baseline
    lines.push(
      `  baseline tier: ${b.scenes.length} scene(s), ${b.variants} shader variant(s), ${b.entryPoints} entry point(s) translated`,
    )
    for (const p of b.problems)
      lines.push(`  baseline${p.path ? ` ${p.path}` : ''}: [${p.code}] ${p.message}`)
  }
  out.result(report, lines.join('\n'))
  return report.valid ? EXIT.ok : EXIT.failed
}

// --- check ------------------------------------------------------------------------

export interface Diagnostic {
  file: string
  line: number
  column: number
  code: string
  message: string
}

/**
 * Finds a TypeScript compiler: the project's own, else the one the CLI ships with. It's the
 * package's `bin/tsc` script, run with Node: `.bin/tsc` is a shell shim Windows can't spawn.
 */
function findTsc(project: string): string {
  let pkg: string
  try {
    pkg = createRequire(join(project, 'package.json')).resolve('typescript/package.json')
  } catch {
    pkg = createRequire(import.meta.url).resolve('typescript/package.json')
  }
  return join(dirname(pkg), 'bin', 'tsc')
}

/** Runs the type checker on the project; resolves with its diagnostics (project files first). */
export function typecheckProject(
  project: string,
): Promise<{ diagnostics: Diagnostic[]; engine: number; ms: number }> {
  const start = performance.now()
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [findTsc(project), '--noEmit', '-p', 'tsconfig.json', '--pretty', 'false'],
      {
        cwd: project,
      },
    )
    let output = ''
    child.stdout.on('data', (d) => {
      output += d
    })
    child.stderr.on('data', (d) => {
      output += d
    })
    child.on('error', reject)
    child.on('close', () => {
      const all: Diagnostic[] = []
      const re = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/gm
      for (let m = re.exec(output); m; m = re.exec(output)) {
        all.push({
          file: m[1]!.split('\\').join('/'),
          line: Number(m[2]),
          column: Number(m[3]),
          code: m[4]!,
          message: m[5]!,
        })
      }
      const inProject = all.filter(
        (d) => !d.file.startsWith('..') && !d.file.includes('node_modules/'),
      )
      resolvePromise({
        diagnostics: inProject,
        engine: all.length - inProject.length,
        ms: performance.now() - start,
      })
    })
  })
}

/** `procgen/nondeterministic` diagnostics for generator modules under `scripts/`. */
async function nondeterministicCalls(project: string): Promise<Diagnostic[]> {
  const dir = join(project, 'scripts')
  const files = (await readdir(dir, { recursive: true }).catch(() => [] as string[])).filter((f) =>
    /\.(ts|js|mts)$/.test(f),
  )
  const out: Diagnostic[] = []
  for (const f of files.sort()) {
    const file = `scripts/${f.split('\\').join('/')}`
    for (const call of findNondeterminism(file, await readFile(join(dir, f), 'utf8'))) {
      out.push({
        file: call.file,
        line: call.line,
        column: call.column,
        code: 'procgen/nondeterministic',
        message: `${call.call} in a generator module: generators must be pure (use ctx.rng; pass times in as params).`,
      })
    }
  }
  return out
}

export async function check({ out, project }: CommandContext): Promise<number> {
  if (!existsSync(join(project, 'tsconfig.json'))) {
    throw new ShardError('project/not-found', 'No tsconfig.json here', {
      hint: 'Run from a project folder, or pass --project <dir>.',
    })
  }
  const result = await typecheckProject(project)
  // Generators must be pure: clock and Math.random calls in their modules are errors too.
  const found = await nondeterministicCalls(project)
  result.diagnostics.push(...found)
  const lines = [
    result.diagnostics.length === 0
      ? `No type errors (${Math.round(result.ms)} ms).`
      : `${result.diagnostics.length} type error(s):`,
  ]
  for (const d of result.diagnostics)
    lines.push(`  ${d.file}:${d.line}:${d.column} ${d.code}: ${d.message}`)
  if (result.engine > 0) lines.push(`  (${result.engine} more in engine packages; not your code)`)
  out.result(result, lines.join('\n'))
  return result.diagnostics.length > 0 ? EXIT.failed : EXIT.ok
}

// --- import / mv ------------------------------------------------------------------

/** Generators' code hashes, and their jobs on worker threads, for commands that import. */
async function setupGenerators(
  project: string,
  manifest: { name: string; entry: string },
  platform: ReturnType<typeof createNodePlatform>,
): Promise<void> {
  await prepareGenerators({
    root: resolve(project),
    namespace: manifest.name,
    entry: manifest.entry,
    workers: platform.workers,
  })
}

async function projectAssets(project: string) {
  const platform = createNodePlatform({ root: project })
  const { manifest } = await loadProject(platform)
  await importProjectPlugin(resolve(project), manifest)
  await setupGenerators(project, manifest, platform)
  const world = new World()
  return assetServer(world).configure({ platform, roots: manifest.assetRoots })
}

export async function importCommand({ out, project, flags }: CommandContext): Promise<number> {
  const assets = await projectAssets(project)
  const report = await assets.scan({ force: flags.force === true })
  const lines = [
    `Imported ${report.imported.length}, unchanged ${report.unchanged}, failed ${report.failed.length} (${Math.round(report.ms)} ms).`,
  ]
  for (const p of report.imported) lines.push(`  imported ${p}`)
  for (const f of report.failed) {
    lines.push(
      `  FAILED ${f.path}${f.error.path && f.error.path !== f.path ? ` ${f.error.path}` : ''}: [${f.error.code}] ${f.error.message}${f.error.hint ? `\n      hint: ${f.error.hint}` : ''}`,
    )
  }
  for (const m of report.moved) lines.push(`  moved ${m.from} -> ${m.to} (without its .meta)`)
  for (const r of report.removed) lines.push(`  removed ${r}`)
  for (const o of report.orphanedMetas) lines.push(`  warning: ${o} has no source file`)
  out.result(report, lines.join('\n'))
  return report.failed.length > 0 ? EXIT.failed : EXIT.ok
}

export async function mv({ out, project, args }: CommandContext): Promise<number> {
  const [from, to] = args
  if (!from || !to) throw new ShardError('cli/usage', 'Usage: shard mv <from> <to>')
  const assets = await projectAssets(project)
  await assets.scan()
  const result = await assets.move(from, to)
  out.result(
    result,
    `Moved ${result.from} -> ${result.to}.${result.rewritten.length > 0 ? `\nRewrote references in:\n${result.rewritten.map((f) => `  ${f}`).join('\n')}` : ''}`,
  )
  return EXIT.ok
}

// --- tiles -------------------------------------------------------------------------

/** "a,b,c" as numbers, for --chunk and --rect. */
function numbersOf(value: unknown, n: number, flag: string): number[] {
  const parts = String(value).split(',').map(Number)
  if (parts.length !== n || parts.some((v) => !Number.isInteger(v) || v < 0)) {
    throw new ShardError('cli/usage', `--${flag} takes ${n} whole numbers joined by commas`)
  }
  return parts
}

function rectOf(value: unknown, flag: string): TileRect {
  const [x, y, w, h] = numbersOf(value, 4, flag) as [number, number, number, number]
  return { x, y, w, h }
}

function listFlag(value: unknown): string[] {
  return value === undefined ? [] : Array.isArray(value) ? value.map(String) : [String(value)]
}

/**
 * `shard tiles read|edit <asset>`, and `shard tiles <asset> --encoding rows|base64`: tilemap files
 * read and edited by tile name (0059), without running the game. Version 1 files name no tiles:
 * `--atlas <path>` names them.
 */
export async function tiles({ out, project, args, flags }: CommandContext): Promise<number> {
  const verb = args[0] === 'read' || args[0] === 'edit' ? args[0] : undefined
  const file = verb ? args[1] : args[0]
  if (!file || (!verb && flags.encoding === undefined)) {
    throw new ShardError(
      'cli/usage',
      'Usage: shard tiles read|edit <asset> [--layer l] …, or shard tiles <asset> --encoding rows|base64',
    )
  }
  const platform = createNodePlatform({ root: project })
  const json = JSON.parse(await platform.fs.readText(file)) as { $schema?: string }
  const schema = json.$schema
  const data = TilemapData.fromJson(json)
  let atlas: { names: readonly string[] } | undefined
  if (typeof flags.atlas === 'string') {
    const assets = await projectAssets(project)
    await assets.scan()
    await assets.load(flags.atlas)
    const item = assets.item(flags.atlas)
    if (!(item instanceof TextureAtlas)) {
      throw new ShardError('cli/usage', `--atlas ${flags.atlas} is not a texture atlas`)
    }
    atlas = item
  }
  const layer = typeof flags.layer === 'string' ? flags.layer : undefined
  if (verb === 'read') {
    const result = readTiles(
      data,
      {
        layer,
        chunk: flags.chunk === undefined ? undefined : numbersOf(flags.chunk, 2, 'chunk'),
        rect: flags.rect === undefined ? undefined : rectOf(flags.rect, 'rect'),
      },
      atlas,
    )
    const text =
      'rows' in result
        ? result.rows.join('\n')
        : Object.entries(result.chunks)
            .map(([key, rows]) => `${key}:\n${rows.map((r) => `  ${r}`).join('\n')}`)
            .join('\n')
    out.result({ asset: file, ...result }, text)
    return EXIT.ok
  }
  if (verb === 'edit') {
    // --cell x,y=name[:flags] (repeatable), --fill x,y,w,h=name, --chunk cx,cy with --row (repeatable).
    const cells = listFlag(flags.cell).map((c) => {
      const m = /^(\d+),(\d+)=([^:]+)(?::(.+))?$/.exec(c)
      if (!m) throw new ShardError('cli/usage', `--cell takes x,y=name[:flags], got "${c}"`)
      return { x: Number(m[1]), y: Number(m[2]), tile: m[3]!, flags: m[4] ?? '' }
    })
    let fill: { rect: TileRect; tile: string } | undefined
    if (flags.fill !== undefined) {
      const [rect, tile] = String(flags.fill).split('=')
      if (!rect || !tile) throw new ShardError('cli/usage', '--fill takes x,y,w,h=name')
      fill = { rect: rectOf(rect, 'fill'), tile }
    }
    const rowList = listFlag(flags.row)
    if (rowList.length > 0 && flags.chunk === undefined) {
      throw new ShardError('cli/usage', '--row needs --chunk cx,cy')
    }
    const rows =
      rowList.length > 0 ? { chunk: numbersOf(flags.chunk, 2, 'chunk'), rows: rowList } : undefined
    const changed = editTiles(data, { layer, cells, fill, rows }, atlas)
    await platform.fs.writeText(file, tilemapToText(data, { atlas, schema }))
    out.result({ asset: file, changed }, `Changed ${changed} cell(s) in ${file}.`)
    return EXIT.ok
  }
  const encoding = flags.encoding
  if (encoding !== 'rows' && encoding !== 'base64') {
    throw new ShardError('cli/usage', '--encoding is rows or base64')
  }
  const from = data.palette ? data.encoding : 'version 1'
  data.encoding = encoding
  await platform.fs.writeText(file, tilemapToText(data, { atlas, schema }))
  out.result({ asset: file, from, encoding }, `Wrote ${file} as ${encoding} (was ${from}).`)
  return EXIT.ok
}

// --- run / screenshot / describe --------------------------------------------------

async function withProject<T>(
  ctx: CommandContext,
  options: Omit<OpenProjectOptions, 'root' | 'gpu'>,
  fn: (p: HeadlessProject) => Promise<T>,
): Promise<T> {
  const p = await openProject({ root: ctx.project, ...options })
  try {
    return await fn(p)
  } finally {
    p.close()
  }
}

export async function run(ctx: CommandContext): Promise<number> {
  const frames = flagNumber(ctx.flags.frames, 600)
  const scene = ctx.flags.scene as string | undefined
  const seed = ctx.flags.seed === undefined ? undefined : flagNumber(ctx.flags.seed, 0)
  return withProject(ctx, { loadStartScene: !scene, seed }, async (p) => {
    if (scene)
      loadScene(p.app.world, JSON.parse(await p.platform.fs.readText(scene)), { id: scene })
    const start = performance.now()
    const loop = () => {
      for (let i = 0; i < frames; i++) p.app.update(1 / p.app.fixedHz)
    }
    // --cpu-prof (0074): V8's sampling profiler over the frames, written as a .cpuprofile.
    const profiled = ctx.flags['cpu-prof'] ? await withCpuProfile(p.root, loop) : undefined
    if (!profiled) loop()
    const result = {
      frames,
      seed: p.manifest.seed,
      entities: p.app.world.entityCount,
      hash: worldHash(p.app.world),
      ms: Math.round(performance.now() - start),
      errors: await localTarget('headless', p.server).request('errors.recent', { count: 20 }),
      ...(profiled && { profilePath: profiled.profilePath, hottest: profiled.hottest }),
    }
    ctx.out.result(
      result,
      `Ran ${frames} frames in ${result.ms} ms: ${result.entities} entities, hash ${result.hash.slice(0, 16)}…` +
        (profiled
          ? `\nCPU profile: ${profiled.profilePath} (hottest: ${profiled.hottest
              .slice(0, 3)
              .map((f) => f.name)
              .join(', ')})`
          : ''),
    )
    return EXIT.ok
  })
}

export async function bake(ctx: CommandContext): Promise<number> {
  if (ctx.args[0] !== 'nav') {
    throw new ShardError(
      'cli/usage',
      'Usage: shard bake nav [--scene scenes/level.scene.json] [--force]',
    )
  }
  const scene = ctx.flags.scene as string | undefined
  return withProject(ctx, { loadStartScene: !scene }, async (p) => {
    if (scene) {
      loadScene(p.app.world, JSON.parse(await p.platform.fs.readText(scene)), { id: scene })
      await whenSceneReady(p.app.world, scene)
    }
    // A frame so transforms propagate and sources are gathered before the bake.
    p.app.update(1 / p.app.fixedHz)
    const result = await localTarget('headless', p.server).request<{
      meshes: {
        path: string | null
        tiles: number
        polygons: number
        built: number
        fromCache: number
        ms: number
        problem: string | null
      }[]
      saved: { file: string; bytes: number } | null
    }>('nav.bake', { force: ctx.flags.force === true })
    const failed = result.meshes.some((m) => m.problem)
    ctx.out.result(
      result,
      result.meshes.length === 0
        ? 'No NavMesh in the scene: nothing to bake.'
        : `${result.meshes
            .map(
              (m) =>
                `${m.path ?? 'navmesh'}: ${m.tiles} tiles, ${m.polygons} polygons (${m.built} built, ${m.fromCache} from cache, ${m.ms} ms)${m.problem ? ` - ${m.problem}` : ''}`,
            )
            .join(
              '\n',
            )}${result.saved ? `\nSaved ${result.saved.file} (${result.saved.bytes} bytes).` : ''}`,
    )
    return failed ? EXIT.failed : EXIT.ok
  })
}

export async function screenshot(ctx: CommandContext): Promise<number> {
  const scene = ctx.args[0]
  const outFile = ctx.flags.out as string | undefined
  if (!scene || !outFile)
    throw new ShardError(
      'cli/usage',
      'Usage: shard screenshot <scene> --out shot.png [--size 1280x720] [--frames 60] [--camera path]',
    )
  const size = parseSize(ctx.flags.size)
  return withProject(
    ctx,
    { width: size?.[0], height: size?.[1], loadStartScene: false },
    async (p) => {
      loadScene(p.app.world, JSON.parse(await p.platform.fs.readText(scene)), { id: scene })
      // Frames run synchronously: wait for the scene's assets first, or systems that need them
      // (tilemaps, navigation) sit out every frame before the capture.
      await whenSceneReady(p.app.world, scene)
      const frames = flagNumber(ctx.flags.frames, 60)
      const gpu = p.app.world.tryResource(Gpu)
      for (let i = 0; i < frames; i++) {
        p.app.update(1 / p.app.fixedHz)
        // Shaders link and pipelines compile asynchronously, and GPU readbacks land between
        // frames: work that waits on them (terrain generation, a new material) gets them within
        // the frames asked for, as it would in a running game, not after the capture.
        if (gpu) {
          await p.app.world.tryResource(Shaders)?.whenIdle()
          if (gpu.pipelines.pending > 0) await gpu.pipelines.whenIdle()
          await new Promise((r) => setTimeout(r, 0))
        }
      }
      const shot = await localTarget('headless', p.server).request<{
        data: string
        width: number
        height: number
      }>('render.capture', {
        camera: ctx.flags.camera,
      })
      const file = resolve(outFile)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, Buffer.from(shot.data, 'base64'))
      ctx.out.result(
        { out: file, width: shot.width, height: shot.height, frames },
        `Wrote ${outFile} (${shot.width}×${shot.height}).`,
      )
      return EXIT.ok
    },
  )
}

// --- track -----------------------------------------------------------------------

/**
 * Records a physics track (0053) headless from a TrackScene JSON file, or from a recording file
 * `{ scene, contacts }`, and prints its hash: two machines that print the same hash recorded the
 * same track. Needs no project.
 */
export async function track(ctx: CommandContext): Promise<number> {
  const file = ctx.args[0]
  if (!file) throw new ShardError('cli/usage', 'Usage: shard track <scene.json> [--out track.bin]')
  const json = JSON.parse(await readFile(resolve(file), 'utf8')) as {
    scene?: unknown
    contacts?: TrackContactOptions
  }
  const scene = trackSceneFromJson(json.scene ?? json)
  const recorded = await recordTrack(scene, { contacts: json.scene ? json.contacts : undefined })
  const outFile = ctx.flags.out as string | undefined
  let out: string | undefined
  if (outFile) {
    out = resolve(outFile)
    await mkdir(dirname(out), { recursive: true })
    await writeFile(out, new Uint8Array(encodeTrack(recorded)))
  }
  const hex = (h: number) => h.toString(16).padStart(8, '0')
  const result = {
    hash: hex(trackHash(recorded)),
    sceneHash: hex(recorded.sceneHash),
    engine: recorded.engine,
    steps: recorded.steps,
    settled: recorded.settled,
    maxStepsHit: recorded.maxStepsHit,
    bodies: recorded.bodyCount,
    contacts: recorded.contacts.steps.length,
    simulationMs: Math.round(recorded.simulationMs * 10) / 10,
    out: out ?? null,
  }
  ctx.out.result(
    result,
    `Track ${result.hash}: ${result.steps} steps, ${result.settled ? 'settled' : 'hit maxSteps'}, ${result.bodies} bodies, ${result.contacts} contacts (${result.simulationMs} ms)${out ? `\nWrote ${outFile}.` : ''}`,
  )
  return EXIT.ok
}

// --- gen -------------------------------------------------------------------------

/** `--param radius=2 --param shape=assets/noise/rock.noise.json`: typed by the generator's schema. */
function parseParams(values: unknown, generator: string): Record<string, unknown> {
  const list = Array.isArray(values) ? values : values === undefined ? [] : [values]
  const out: Record<string, unknown> = {}
  const gen = (() => {
    try {
      return requireGenerator(generator)
    } catch {
      return undefined
    }
  })()
  for (const item of list as string[]) {
    const eq = item.indexOf('=')
    if (eq <= 0)
      throw new ShardError('cli/usage', `--param must look like name=value, got "${item}"`)
    const key = item.slice(0, eq)
    const raw = item.slice(eq + 1)
    const field = gen?.params.fields[key]
    if (field?.kind === 'handle') out[key] = { path: raw }
    else {
      try {
        out[key] = JSON.parse(raw)
      } catch {
        out[key] = raw
      }
    }
  }
  return out
}

export async function gen(ctx: CommandContext): Promise<number> {
  const target = ctx.args[0]
  if (!target) {
    throw new ShardError(
      'cli/usage',
      'Usage: shard gen <generator|file.gen.json> [--seed N | --seeds 1-9] [--param k=v] [--size 256] [--out sheet.png]',
    )
  }
  return withProject(ctx, { loadStartScene: false }, async (p) => {
    const local = localTarget('headless', p.server)
    const described = await local.request<{ generators: { name: string }[] }>('procgen.describe')
    const name = target.startsWith('scripts:') ? `${p.manifest.name}/${target.slice(8)}` : target
    const known = described.generators.find((g) => g.name === name || g.name.endsWith(`/${name}`))
    const generator = target.includes('.gen.json') ? target : (known?.name ?? name)
    const params = parseParams(ctx.flags.param, known?.name ?? name)
    const seeds =
      ctx.flags.seeds !== undefined
        ? String(ctx.flags.seeds)
        : ctx.flags.seed !== undefined
          ? String(flagNumber(ctx.flags.seed, 0))
          : undefined
    const list = seeds === undefined ? [undefined] : parseSeedList(seeds)
    const results: Record<string, unknown>[] = []
    for (const seed of list) {
      results.push(
        await local.request('procgen.run', {
          generator,
          params,
          ...(seed === undefined ? {} : { seed }),
        }),
      )
    }
    let written: { out: string; width: number; height: number } | undefined
    const outFile = ctx.flags.out as string | undefined
    if (outFile) {
      const size = ctx.flags.size ? flagNumber(ctx.flags.size, 256) : 256
      const shot = await local.request<{ data: string; width: number; height: number }>(
        'procgen.preview',
        {
          generator,
          params,
          size,
          ...(ctx.flags.seeds !== undefined
            ? { seeds }
            : list[0] !== undefined
              ? { seed: list[0] }
              : {}),
        },
      )
      const file = resolve(outFile)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, Buffer.from(shot.data, 'base64'))
      written = { out: file, width: shot.width, height: shot.height }
    }
    const lines = results.map((r) => {
      const s = r as {
        generator: string
        seed: number
        hit: string
        ms: number
        key?: string
        vertices?: number
        triangles?: number
        entities?: number
        output: string
      }
      const size =
        s.vertices !== undefined
          ? `${s.vertices} vertices, ${s.triangles} triangles`
          : s.entities !== undefined
            ? `${s.entities} entities`
            : s.output
      return `${s.generator} seed ${s.seed}: ${size} (${s.hit === 'run' ? `ran in ${s.ms} ms` : `cache: ${s.hit}`}) key ${s.key?.slice(0, 12) ?? '-'}`
    })
    if (written) lines.push(`Wrote ${outFile} (${written.width}×${written.height}).`)
    ctx.out.result({ generator, results, ...(written ? written : {}) }, lines.join('\n'))
    return EXIT.ok
  })
}

function parseSeedList(spec: string): number[] {
  const out: number[] = []
  for (const part of spec.split(',')) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(part)
    if (!m) throw new ShardError('cli/usage', `--seeds must look like 1-9 or 1,4,9, got "${spec}"`)
    const a = Number(m[1])
    const b = m[2] === undefined ? a : Number(m[2])
    for (let s = Math.min(a, b); s <= Math.max(a, b); s++) out.push(s)
  }
  return out
}

export async function describe(ctx: CommandContext): Promise<number> {
  return withProject(ctx, {}, async (p) => {
    const app = await localTarget('headless', p.server).request('app.describe')
    ctx.out.result({ manifest: p.manifest, sceneFiles: await listScenes(p.root), app })
    return EXIT.ok
  })
}

// --- docs ----------------------------------------------------------------------

export async function docs({ out, project }: CommandContext): Promise<number> {
  const platform = createNodePlatform({ root: project })
  const { manifest } = await loadProject(platform)
  await importProjectPlugin(resolve(project), manifest) // registers project components for the catalog
  const files = generateDocs(manifest, await collectErrorCodes())
  const existing = await platform.fs.readText('AGENTS.md').catch(() => undefined)
  files['AGENTS.md'] = mergeAgentsMd(existing, manifest)
  for (const [path, content] of Object.entries(files)) await platform.fs.writeText(path, content)
  const written = Object.keys(files).sort()
  out.result({ written }, `Wrote ${written.length} files: AGENTS.md, .agents/, .shard/schemas/.`)
  return EXIT.ok
}

// --- test ------------------------------------------------------------------------

interface TestReport {
  passed: number
  failed: number
  skipped: number
  tests: { file: string; name: string; state: string; error?: string }[]
  /** `.cpuprofile`s written by --cpu-prof, project-relative. */
  profiles?: string[]
}

export async function testCommand({ out, project, args, flags }: CommandContext): Promise<number> {
  const { startVitest } = await import('vitest/node')
  const root = resolve(project)
  process.env.SHARD_PROJECT_ROOT = root
  // --cpu-prof (0074): each test file's process runs under V8's --cpu-prof.
  const profileDir = join(root, CAPTURES_DIR)
  const before = flags['cpu-prof'] ? new Set(await readdir(profileDir).catch(() => [])) : undefined
  const vitest = await startVitest('test', args, {
    root,
    include: ['tests/**/*.test.ts'],
    watch: false,
    reporters: out.json ? [{ onInit() {} }] : ['default'],
    testTimeout: 60_000,
    fileParallelism: false,
    ...(before && {
      pool: 'forks',
      execArgv: ['--cpu-prof', '--cpu-prof-dir', profileDir],
    }),
  })
  const report: TestReport = { passed: 0, failed: 0, skipped: 0, tests: [] }
  if (before) {
    const files = await readdir(profileDir).catch(() => [] as string[])
    report.profiles = files
      .filter((f) => f.endsWith('.cpuprofile') && !before.has(f))
      .map((f) => relative(root, join(profileDir, f)))
  }
  const visit = (task: {
    type: string
    name: string
    tasks?: unknown[]
    result?: { state?: string; errors?: { message: string }[] }
    file?: { name: string }
  }) => {
    if (task.type === 'test') {
      const state = task.result?.state ?? 'skip'
      if (state === 'pass') report.passed++
      else if (state === 'fail') report.failed++
      else report.skipped++
      report.tests.push({
        file: task.file?.name ?? '',
        name: task.name,
        state,
        ...(task.result?.errors?.[0] ? { error: task.result.errors[0].message } : {}),
      })
    }
    for (const child of (task.tasks ?? []) as (typeof task)[]) visit(child)
  }
  for (const file of vitest?.state.getFiles() ?? []) visit(file as never)
  await vitest?.close()
  const failedToRun = (vitest?.state.getUnhandledErrors().length ?? 0) > 0
  out.result(
    report,
    `${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped.${report.profiles ? `\nCPU profiles: ${report.profiles.join(', ') || 'none'}` : ''}`,
  )
  return report.failed > 0 || failedToRun ? EXIT.failed : EXIT.ok
}

// --- serve / mcp -------------------------------------------------------------------

/** Runs `shard test --json` in a child process (isolated from the server's own app). */
function runTestsChild(project: string): (pattern?: string) => Promise<unknown> {
  const bin = resolve(dirname(fileURLToPath(import.meta.url)), '../bin/shard.mjs')
  return (pattern) =>
    new Promise((resolvePromise) => {
      const child = spawn(
        process.execPath,
        [bin, 'test', '--json', '--project', project, ...(pattern ? [pattern] : [])],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d) => (stdout += d))
      child.stderr.on('data', (d) => (stderr += d))
      child.on('close', (code) => {
        try {
          resolvePromise(JSON.parse(stdout))
        } catch {
          resolvePromise({ exitCode: code, output: stderr.slice(-4000) })
        }
      })
    })
}

export async function serve(ctx: CommandContext): Promise<number> {
  const hub = new Hub()
  const port = await hub.start(
    flagNumber(ctx.flags.port ?? process.env.SHARD_HUB_PORT, DEFAULT_HUB_PORT),
  )
  const headless = existsSync(join(ctx.project, 'shard.json'))
    ? await openProject({ root: ctx.project, watch: true, userData: 'files' })
    : undefined
  const target = (): ProtocolTarget | undefined =>
    hub.current() ?? (headless ? localTarget('headless', headless.server) : undefined)
  ctx.out.say(
    `Protocol hub on ws://127.0.0.1:${port}${headless ? ` (headless project: ${headless.manifest.name})` : ''}`,
  )
  hub.onAttach((name, attached) => ctx.out.say(`${attached ? 'attached' : 'detached'}: ${name}`))
  hub.onNotification((from, n) => process.stdout.write(`${JSON.stringify({ ...n, from })}\n`))
  // stdio: one JSON-RPC request per line, answered on stdout.
  const lines = createInterface({ input: process.stdin })
  for await (const line of lines) {
    if (!line.trim()) continue
    let request: { id?: number | string; method: string; params?: unknown }
    try {
      request = JSON.parse(line)
    } catch {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`,
      )
      continue
    }
    const t = target()
    try {
      if (!t) throw new ShardError('cli/no-target', 'No app attached and no project here')
      const result = await t.request(request.method, request.params)
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: request.id ?? null, result })}\n`,
      )
    } catch (err) {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: request.id ?? null, error: { code: -32000, message: (err as Error).message, data: errorJson(err) } })}\n`,
      )
    }
  }
  hub.close()
  headless?.close()
  return EXIT.ok
}

export async function mcp(ctx: CommandContext): Promise<number> {
  const headless = await openProject({ root: ctx.project, watch: true, userData: 'files' })
  let hub: Hub | undefined
  if (ctx.flags.attach) {
    hub = new Hub()
    await hub.start(flagNumber(ctx.flags.port ?? process.env.SHARD_HUB_PORT, DEFAULT_HUB_PORT))
  }
  const local = localTarget('headless', headless.server)
  const server = createMcpServer({
    root: headless.root,
    target: () => hub?.current() ?? local,
    runTests: runTestsChild(headless.root),
    typecheck: () => typecheckProject(headless.root),
  })
  const transport = new StdioServerTransport()
  await server.connect(transport)
  await new Promise<void>((resolveClose) => {
    transport.onclose = () => resolveClose()
    process.stdin.on('end', () => resolveClose())
  })
  hub?.close()
  headless.close()
  return EXIT.ok
}

export { formatError }

export async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'))
}
