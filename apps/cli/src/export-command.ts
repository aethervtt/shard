import { join, resolve } from 'node:path'
import { ShardError } from '@aethervtt/shard-core'
import { bakeBuildShaders, importProjectPlugin, openBuild } from '@aethervtt/shard-node'
import { createNodePlatform } from '@aethervtt/shard-platform-node'
import { loadProject, projectNet } from '@aethervtt/shard-project'
import { type CommandContext, importCommand, validate } from './commands'
import { type ExportReport, exportBuild } from './export'
import { EXIT, type Output } from './output'
import { bakeShaders } from './shaders'

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

/**
 * Imports and validates the project, then exports it (0110): what `shard export` and the MCP
 * `export` tool run. Fails on any import or validation error.
 */
export async function exportProject(
  root: string,
  options: {
    target?: 'web' | 'server'
    out?: string
    /** Data in `.shardpak` files; default `export.pack`, else true for servers. */
    pack?: boolean
    /** Server: also export the web page into `public/`, which the server serves. */
    static?: boolean
    dryRun?: boolean
    sourcemap?: boolean
    say?(message: string): void
  },
): Promise<ExportReport & { page?: ExportReport }> {
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
  const exported = (t: 'web' | 'server', out: string | undefined) =>
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
        const baked = await bakeShaders(root, scenes)
        return baked.failed.map((f) => `export/webgl2-bake: ${JSON.stringify(f)}`)
      },
      bake: (dir, build, scenes) =>
        bakeBuildShaders(dir, build, scenes, manifest.export?.bakeFrames ?? 60),
    })
  const report = await exported(target, options.out)
  if (target !== 'server' || !options.static || options.dryRun) return report
  say('Exporting the page into public/…')
  return { ...report, page: await exported('web', join(report.out, 'public')) }
}

/** `shard export --target web [--out dist/web] [--dry-run] [--sourcemap]` (0110). */
export async function exportCommand(ctx: CommandContext): Promise<number> {
  const target = (ctx.flags.target as string | undefined) ?? 'web'
  if (target !== 'web' && target !== 'server') {
    throw new ShardError('export/unknown-target', `Unknown export target "${target}"`, {
      hint: 'Targets: web, server. Desktop shells follow (spec 0111).',
    })
  }
  const report = await exportProject(ctx.project, {
    target,
    static: ctx.flags.static === true,
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
