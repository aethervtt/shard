import { ShardError } from '@aethervtt/shard-core'
import { listScenes } from '@aethervtt/shard-node'
import type { CommandContext } from './commands'
import { EXIT } from './output'
import { bakeShaders } from './shaders'

/** `shard shaders bake` (0064). */
export async function shaders(ctx: CommandContext): Promise<number> {
  if (ctx.args[0] !== 'bake') {
    throw new ShardError(
      'cli/usage',
      'Usage: shard shaders bake [--manifest shaders.variants.json] [--out .shard/shaders/webgl2.json]',
    )
  }
  const report = await bakeShaders(ctx.project, await listScenes(ctx.project), {
    manifest: ctx.flags.manifest as string | undefined,
    out: ctx.flags.out as string | undefined,
  })
  const manifest = report.manifest
    ? ` and ${report.manifest.variants} variant(s) of ${report.manifest.file}`
    : ''
  const lines = [
    `Baked ${report.stages} pipeline stage(s) from ${report.scenes.length} scene(s)${manifest}: ${report.translations} translation(s), ${(report.bytes / 1024).toFixed(0)} KB, in ${report.out}`,
  ]
  for (const f of report.failed) {
    lines.push(`  ${f.label}${f.entry ? ` (${f.stage} ${f.entry})` : ''}: [${f.code}] ${f.message}`)
  }
  ctx.out.result(report, lines.join('\n'))
  return report.failed.length > 0 ? EXIT.failed : EXIT.ok
}
