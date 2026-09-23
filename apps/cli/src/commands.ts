import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
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
import { loadScene, validateScene } from '@shard/scene'
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
  const report: { valid: boolean; manifest: unknown[]; scenes: Record<string, unknown[]> } = {
    valid: true,
    manifest: manifestErrors.map((e) => e.toJSON()),
    scenes: {},
  }
  if (manifestErrors.length === 0) {
    const { manifest } = await loadProject(platform)
    await importProjectPlugin(resolve(project), manifest) // defines the project's components
    const world = new World()
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
      report.scenes[scene] = validateScene(world, json, { id: scene }).map((e) => e.toJSON())
    }
  }
  const problems =
    report.manifest.length + Object.values(report.scenes).reduce((n, e) => n + e.length, 0)
  report.valid = problems === 0
  const lines = [report.valid ? 'Valid.' : `${problems} problem(s):`]
  for (const e of report.manifest as { code: string; path?: string; message: string }[])
    lines.push(`  shard.json${e.path ?? ''}: [${e.code}] ${e.message}`)
  for (const [scene, errors] of Object.entries(report.scenes)) {
    for (const e of errors as { code: string; path?: string; message: string; hint?: string }[]) {
      lines.push(
        `  ${scene}${e.path ?? ''}: [${e.code}] ${e.message}${e.hint ? `\n      hint: ${e.hint}` : ''}`,
      )
    }
  }
  out.result(report, lines.join('\n'))
  return report.valid ? EXIT.ok : EXIT.failed
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
    ? await openProject({ root: ctx.project })
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
  const headless = await openProject({ root: ctx.project })
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
