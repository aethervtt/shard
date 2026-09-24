import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { assetServer } from '@shard/assets'
import { ShardError, World } from '@shard/core'
import {
  collectErrorCodes,
  createNodePlatform,
  type HeadlessProject,
  importProjectPlugin,
  listScenes,
  type OpenProjectOptions,
  openProject,
  worldHash,
} from '@shard/node'
import {
  generateDocs,
  loadProject,
  mergeAgentsMd,
  projectTemplate,
  type TemplateName,
  validateManifest,
} from '@shard/project'
import { DEFAULT_HUB_PORT } from '@shard/protocol'
import { loadInstanceAssets, loadScene, validatePrefab, validateScene } from '@shard/scene'
import { Hub, localTarget, type ProtocolTarget } from './hub'
import { createMcpServer } from './mcp'
import { EXIT, errorJson, formatError, type Output } from './output'

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

export async function validate({ out, project }: CommandContext): Promise<number> {
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
  } = {
    valid: true,
    manifest: manifestErrors.map((e) => e.toJSON()),
    assets: [],
    scenes: {},
    prefabs: {},
    warnings: [],
  }
  if (manifestErrors.length === 0) {
    const { manifest } = await loadProject(platform)
    await importProjectPlugin(resolve(project), manifest) // defines the project's components
    const world = new World()
    // Scenes reference assets by path, so the catalog has to be current first.
    const scan = await assetServer(world).configure({ platform, roots: manifest.assetRoots }).scan()
    report.assets = scan.failed.map((f) => ({ ...f.error, source: f.path }))
    for (const meta of scan.orphanedMetas) report.warnings.push(`${meta} has no source file`)
    for (const m of scan.moved)
      report.warnings.push(`${m.from} moved to ${m.to} without its .meta; references may be stale`)
    const failed = new Set(scan.failed.map((f) => f.path))
    // Instance overrides are checked against their prefab or model, so those load first.
    for (const entry of assetServer(world).list({ type: 'Prefab' })) {
      if (!entry.source || failed.has(entry.source)) continue // reported with the imports
      const json = JSON.parse(await platform.fs.readText(entry.source))
      await loadInstanceAssets(world, json)
      report.prefabs[entry.source] = validatePrefab(world, json, { id: entry.source }).map((e) =>
        e.toJSON(),
      )
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
      report.scenes[scene] = validateScene(world, json, { id: scene }).map((e) => e.toJSON())
    }
  }
  const problems =
    report.manifest.length +
    report.assets.length +
    Object.values(report.scenes).reduce((n, e) => n + e.length, 0) +
    Object.values(report.prefabs).reduce((n, e) => n + e.length, 0)
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

/** Finds a TypeScript compiler: the project's own, else the one the CLI ships with. */
function findTsc(project: string): string {
  const local = join(project, 'node_modules', '.bin', 'tsc')
  if (existsSync(local)) return local
  const require = createRequire(import.meta.url)
  const pkg = require.resolve('typescript/package.json')
  return join(dirname(pkg), 'bin', 'tsc')
}

/** Runs the type checker on the project; resolves with its diagnostics (project files first). */
export function typecheckProject(
  project: string,
): Promise<{ diagnostics: Diagnostic[]; engine: number; ms: number }> {
  const start = performance.now()
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      findTsc(project),
      ['--noEmit', '-p', 'tsconfig.json', '--pretty', 'false'],
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

export async function check({ out, project }: CommandContext): Promise<number> {
  if (!existsSync(join(project, 'tsconfig.json'))) {
    throw new ShardError('project/not-found', 'No tsconfig.json here', {
      hint: 'Run from a project folder, or pass --project <dir>.',
    })
  }
  const result = await typecheckProject(project)
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

async function projectAssets(project: string) {
  const platform = createNodePlatform({ root: project })
  const { manifest } = await loadProject(platform)
  await importProjectPlugin(resolve(project), manifest)
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
    for (let i = 0; i < frames; i++) p.app.update(1 / p.app.fixedHz)
    const result = {
      frames,
      seed: p.manifest.seed,
      entities: p.app.world.entityCount,
      hash: worldHash(p.app.world),
      ms: Math.round(performance.now() - start),
      errors: await localTarget('headless', p.server).request('errors.recent', { count: 20 }),
    }
    ctx.out.result(
      result,
      `Ran ${frames} frames in ${result.ms} ms: ${result.entities} entities, hash ${result.hash.slice(0, 16)}…`,
    )
    return EXIT.ok
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
      const frames = flagNumber(ctx.flags.frames, 60)
      for (let i = 0; i < frames; i++) p.app.update(1 / p.app.fixedHz)
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
}

export async function testCommand({ out, project, args }: CommandContext): Promise<number> {
  const { startVitest } = await import('vitest/node')
  const root = resolve(project)
  process.env.SHARD_PROJECT_ROOT = root
  const vitest = await startVitest('test', args, {
    root,
    include: ['tests/**/*.test.ts'],
    watch: false,
    reporters: out.json ? [{ onInit() {} }] : ['default'],
    testTimeout: 60_000,
    fileParallelism: false,
  })
  const report: TestReport = { passed: 0, failed: 0, skipped: 0, tests: [] }
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
  out.result(report, `${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped.`)
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
    ? await openProject({ root: ctx.project, watch: true })
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
  const headless = await openProject({ root: ctx.project, watch: true })
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
