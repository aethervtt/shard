import { existsSync } from 'node:fs'
import { copyFile, cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { ShardError } from '@aethervtt/shard-core'
import { bakeBuildShaders, importProjectPlugin, openBuild } from '@aethervtt/shard-node'
import { createNodePlatform } from '@aethervtt/shard-platform-node'
import { loadProject, type ManifestValue, projectNet } from '@aethervtt/shard-project'
import { type CommandContext, importCommand, validate } from './commands'
import { type ExportReport, exportBuild } from './export'
import { EXIT, type Output } from './output'
import { bakeShaders } from './shaders'
import { compileServer, hostTriple } from './sidecar'
import { checkTauri, scaffoldTauri } from './tauri'

/** An Output that keeps the result instead of printing it: commands run as steps of another. */
function captured(): Output & { data: unknown } {
  const out = {
    json: true,
    data: undefined as unknown,
    say: () => {},
    result(data: unknown) {
      out.data = data
    },
  }
  return out
}

const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`

export type ExportOutcome = ExportReport & {
  page?: ExportReport
  binary?: { file: string; bytes: number }
  /** Tauri (0111): what --init wrote into the app, and where its sidecar went. */
  app?: { dir: string; scaffolded: string[]; sidecar?: { file: string; bytes: number } }
}

/**
 * The desktop app around a Tauri export (0111): scaffolds it with --init, bundles the game server
 * as a sidecar with --sidecar (a server export whose manifest joins the page's data as
 * `server.json`, compiled with Bun into the app's `binaries/`), then checks the app.
 */
async function desktop(
  root: string,
  manifest: ManifestValue,
  report: ExportOutcome,
  options: { init?: boolean; sidecar?: boolean; app?: string },
  say: (message: string) => void,
  exportServer: (out: string) => Promise<ExportReport>,
): Promise<ExportOutcome> {
  const appDir = resolve(root, options.app || manifest.export?.tauri?.app || 'src-tauri')
  const out = resolve(root, report.out)
  const server = options.sidecar ? `${manifest.name}-server` : undefined
  const app = { root, manifest, out, appDir, server }
  const scaffolded = options.init ? await scaffoldTauri(app) : []
  if (scaffolded.length > 0) say(`Scaffolded ${relative(root, appDir) || '.'}/ (yours from now on)`)
  let sidecar: { file: string; bytes: number } | undefined
  if (server) {
    if (!existsSync(appDir)) {
      throw new ShardError('export/no-tauri-app', `No Tauri app at ${relative(root, appDir)}`, {
        hint: 'Add --init to scaffold one, or set export.tauri.app to yours.',
      })
    }
    say('Exporting the game server…')
    await mkdir(join(root, '.shard/export'), { recursive: true })
    const temp = await mkdtemp(join(root, '.shard/export/sidecar-'))
    try {
      await exportServer(temp)
      // The server reads the page's data: its manifest beside the page's, and any file it ships
      // that the page doesn't (same packs, so normally none).
      const data = join(out, 'data')
      await copyFile(join(temp, 'build.json'), join(data, 'server.json'))
      await cp(join(temp, 'f'), join(data, 'f'), { recursive: true, force: false })
      say('Compiling the game server with Bun…')
      const entry = manifest.export?.server?.entry
      const triple = hostTriple()
      const compiled = compileServer({
        entry: entry ? resolve(root, entry) : join(temp, 'server.mjs'),
        outfile: join(appDir, 'binaries', `${server}-${triple}`),
        triple,
      })
      sidecar = { file: compiled.file, bytes: compiled.bytes }
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  }
  report.warnings.push(...(await checkTauri(app)))
  return { ...report, app: { dir: appDir, scaffolded, ...(sidecar ? { sidecar } : {}) } }
}

/**
 * Imports and validates the project, then exports it (0110): what `shard export` and the MCP
 * `export` tool run. Fails on any import or validation error.
 */
export async function exportProject(
  root: string,
  options: {
    target?: 'web' | 'server' | 'tauri'
    out?: string
    /** Tauri: scaffold the app (`export.tauri.app`) when it doesn't exist (0111). */
    init?: boolean
    /** Tauri: bundle the game server as a sidecar, compiled with Bun (0111). */
    sidecar?: boolean
    /** Tauri: the app's folder, over `export.tauri.app`. */
    app?: string
    /** Data in `.shardpak` files; default `export.pack`, else true for servers. */
    pack?: boolean
    /** Server: also compile it into one executable with Bun, beside its data (0111). */
    compile?: boolean
    /** Server: also export the web page into `public/`, which the server serves. */
    static?: boolean
    dryRun?: boolean
    sourcemap?: boolean
    say?(message: string): void
  },
): Promise<ExportOutcome> {
  const say = options.say ?? (() => {})
  const ctx: CommandContext = { out: captured(), project: root, args: [], flags: {} }
  say('Importing…')
  const imported = captured()
  if ((await importCommand({ ...ctx, out: imported })) !== EXIT.ok) {
    throw new ShardError('export/validate-failed', 'Some assets failed to import', {
      hint: 'Run `shard import` to see which, and fix them.',
      details: imported.data as never,
    })
  }
  say('Validating…')
  const validated = captured()
  if ((await validate({ ...ctx, out: validated })) !== EXIT.ok) {
    throw new ShardError('export/validate-failed', 'The project has validation errors', {
      hint: 'Run `shard validate` and fix every error first.',
      details: validated.data as never,
    })
  }
  const { manifest } = await loadProject(createNodePlatform({ root }))
  const target = options.target ?? 'web'
  const multiplayer = projectNet(await importProjectPlugin(resolve(root), manifest)) !== undefined
  if (target === 'server' && !multiplayer) {
    throw new ShardError('project/not-multiplayer', `${manifest.name} has no project.net(...)`, {
      hint: 'Call project.net({ replicate, commands, … }) in the entry to make it multiplayer.',
    })
  }
  if (target === 'tauri' && multiplayer) {
    const net = manifest.export?.net
    if (!net?.url && !net?.lobby) {
      throw new ShardError('export/net-url-missing', 'A desktop app has no origin to join', {
        hint: 'Set export.net.url in shard.json: "local" with --sidecar, a wss:// server, or a lobby.',
      })
    }
    if (net.url === 'local' && !options.sidecar) {
      throw new ShardError(
        'export/net-url-missing',
        'export.net.url is "local" but no server ships',
        {
          hint: 'Add --sidecar to bundle the game server, or point export.net.url at a server.',
        },
      )
    }
  }
  const exported = (t: 'web' | 'server' | 'tauri', out: string | undefined) =>
    exportBuild({
      root,
      target: t,
      multiplayer,
      pack: options.pack,
      out,
      dryRun: options.dryRun,
      sourcemap: options.sourcemap,
      say,
      async prepareShaders(scenes) {
        say('Translating shaders for WebGL2…')
        try {
          const baked = await bakeShaders(root, scenes)
          return baked.failed.map((f) => `export/webgl2-bake: ${JSON.stringify(f)}`)
        } catch (err) {
          // Like the shader bake: without a GPU the export still ships, and WebGL2 loads naga.
          if ((err as { code?: string }).code !== 'cli/no-gpu') throw err
          return ['export/no-webgl2-bake: no GPU adapter; WebGL2 translates shaders with naga']
        }
      },
      bake: (dir, build, scenes, codeDir) =>
        bakeBuildShaders(dir, build, scenes, manifest.export?.bakeFrames ?? 60, codeDir),
    })
  const report: ExportOutcome = await exported(target, options.out)
  if (target === 'tauri' && !options.dryRun) {
    return desktop(root, manifest, report, options, say, (out) => exported('server', out))
  }
  if (target !== 'server' || options.dryRun) return report
  if (options.static) {
    say('Exporting the page into public/…')
    report.page = await exported('web', join(report.out, 'public'))
  }
  if (options.compile) {
    say('Compiling the server with Bun…')
    const out = resolve(root, report.out)
    const compiled = compileServer({
      entry: join(out, 'server.mjs'),
      outfile: join(out, `${manifest.name}-server`),
    })
    report.binary = { file: compiled.file, bytes: compiled.bytes }
  }
  return report
}

/** `shard export --target web [--out dist/web] [--dry-run] [--sourcemap]` (0110). */
export async function exportCommand(ctx: CommandContext): Promise<number> {
  const target = (ctx.flags.target as string | undefined) ?? 'web'
  if (target !== 'web' && target !== 'server' && target !== 'tauri') {
    throw new ShardError('export/unknown-target', `Unknown export target "${target}"`, {
      hint: 'Targets: web, server, tauri. Electron follows (spec 0111).',
    })
  }
  const report = await exportProject(ctx.project, {
    target,
    static: ctx.flags.static === true,
    init: ctx.flags.init === true,
    sidecar: ctx.flags.sidecar === true,
    app: ctx.flags.app as string | undefined,
    compile: ctx.flags.compile === true,
    pack: ctx.flags.pack === true ? true : undefined,
    out: ctx.flags.out as string | undefined,
    dryRun: ctx.flags['dry-run'] === true,
    sourcemap: ctx.flags.sourcemap === true,
    say: (m) => ctx.out.say(m),
  })
  const lines = ctx.flags['dry-run']
    ? [
        `Would ship ${report.included.length} file(s); ${report.excluded.length} asset source(s) left out.`,
        ...report.excluded.map((p) => `  excluded ${p}`),
      ]
    : [
        `Exported ${report.out} (build ${report.build}): ${report.files} files, ${kb(report.bytes.brotli)} brotli (${kb(report.bytes.raw)} raw).`,
        `  code: entry ${kb(report.code.entry)}, lazy ${kb(report.code.lazy)}, worker ${kb(report.code.worker)}, wasm ${kb(report.code.wasm)} (brotli)`,
        ...report.excluded.map((p) => `  excluded ${p}`),
      ]
  if (report.page) lines.push(`  page: ${report.page.out} (build ${report.page.build})`)
  if (report.app) {
    for (const f of report.app.scaffolded)
      lines.push(`  wrote ${relative(ctx.project, join(report.app.dir, f))}`)
    if (report.app.sidecar) {
      lines.push(
        `  sidecar: ${relative(ctx.project, report.app.sidecar.file)} (${kb(report.app.sidecar.bytes)})`,
      )
    }
    lines.push(
      `Build it: cd ${relative(ctx.project, report.app.dir) || '.'} && cargo tauri build (or your bundle script)`,
    )
  }
  if (report.binary) {
    lines.push(
      `  executable: ${report.binary.file} (${kb(report.binary.bytes)}, nothing to install)`,
    )
  }
  if (target === 'server' && !ctx.flags['dry-run']) {
    lines.push(`Run it: node ${report.out}/server.mjs --port 7000 (or docker build ${report.out})`)
  }
  for (const w of report.warnings) lines.push(`  warning: ${w}`)
  ctx.out.result(report, lines.join('\n'))
  return EXIT.ok
}

/** `shard run --build <dir>`: runs an export headless and prints its world hash (0110). */
export async function runBuild(ctx: CommandContext, frames: number): Promise<number> {
  const seed = ctx.flags.seed === undefined ? undefined : Number(ctx.flags.seed)
  const scene = ctx.flags.scene as string | undefined
  const opened = await openBuild(resolve(ctx.project, ctx.flags.build as string), {
    seed,
    startScene: !scene,
  })
  try {
    if (scene) await opened.handle.loadScene(scene)
    const start = performance.now()
    opened.handle.frames(frames)
    const result = {
      frames,
      seed: seed ?? opened.build.manifest.seed,
      build: opened.build.build,
      entities: opened.handle.entities(),
      hash: opened.hash(),
      ms: Math.round(performance.now() - start),
    }
    ctx.out.result(
      result,
      `Ran build ${result.build} for ${frames} frames in ${result.ms} ms: ${result.entities} entities, hash ${result.hash.slice(0, 16)}…`,
    )
    return EXIT.ok
  } finally {
    opened.close()
  }
}
