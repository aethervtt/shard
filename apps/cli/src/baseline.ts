import type { ShardError } from '@aethervtt/shard-core'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { type GlslStage, loadNaga } from '@aethervtt/shard-gpu-webgl2'
import { openProject } from '@aethervtt/shard-node'
import { RenderHealth, Shaders } from '@aethervtt/shard-render'
import { LogResource } from '@aethervtt/shard-runtime'
import { loadScene, unloadScene, whenSceneReady } from '@aethervtt/shard-scene'

// `shard validate --tier baseline` (0064): the project's scenes, drawn headless at the baseline tier
// on a compatibility-mode device, so every shader variant they use links with BASELINE, passes the
// baseline rewrite and the device's rules (texture units, varyings, views), and every entry point
// translates to GLSL ES 3.00 with naga. Features the tier can't run are reported by name.

export interface BaselineProblem {
  code: string
  message: string
  /** Module and line, or the scene or variant it came from. */
  path?: string
}

export interface BaselineReport {
  scenes: string[]
  variants: number
  entryPoints: number
  problems: BaselineProblem[]
}

/** Frames each scene draws: enough for pipelines to compile and deferred work to run. */
const FRAMES = 30

/** Vertex and fragment entry points of linked WGSL. */
function entryPoints(code: string): [GlslStage, string][] {
  const out: [GlslStage, string][] = []
  for (const m of code.matchAll(/@(vertex|fragment)\s+fn\s+([A-Za-z_]\w*)/g)) {
    out.push([m[1] as GlslStage, m[2]!])
  }
  return out
}

function problemOf(e: ShardError | Error, path?: string): BaselineProblem {
  const code = (e as ShardError).code ?? 'baseline/error'
  const at = (e as ShardError).path ?? path
  return { code, message: e.message, ...(at ? { path: at } : {}) }
}

/** `scenes`: the project's scene files, relative to `root`. */
export async function validateBaseline(
  root: string,
  scenes: readonly string[],
): Promise<BaselineReport> {
  const gpu = await createNodeGpuContext({ tier: 'baseline' })
  const report: BaselineReport = { scenes: [], variants: 0, entryPoints: 0, problems: [] }
  const seen = new Set<string>()
  const add = (p: BaselineProblem) => {
    const key = `${p.code}|${p.path ?? ''}|${p.message}`
    if (seen.has(key)) return
    seen.add(key)
    report.problems.push(p)
  }
  try {
    // The project's code as validate already imported it: one set of component definitions.
    const p = await openProject({
      root,
      gpu,
      loadStartScene: false,
      generatorWorkers: false,
      code: 'source',
    })
    try {
      const world = p.app.world
      for (const path of scenes) {
        report.scenes.push(path)
        loadScene(world, JSON.parse(await p.platform.fs.readText(path)), { id: path })
        await whenSceneReady(world, path)
        for (let i = 0; i < FRAMES; i++) {
          p.app.update(1 / p.app.fixedHz)
          await world.resource(Shaders).whenIdle()
          await gpu.pipelines.whenIdle()
        }
        for (const issue of world.resource(RenderHealth).issues) {
          if (issue.code === 'render/feature-unsupported')
            add({ code: issue.code, message: issue.message, path })
        }
        unloadScene(world, path)
        p.app.update(1 / p.app.fixedHz)
      }
      // What the device refused, and shader links the baseline rewrite rejected.
      for (const e of gpu.errors) add(problemOf(e))
      for (const e of world.resource(LogResource).errors()) {
        if (e.code?.startsWith('shader/') || e.code?.startsWith('gpu'))
          add({ code: e.code, message: e.message, ...(e.path ? { path: e.path } : {}) })
      }
      // Every baseline variant's entry points through naga, as WebGL2 would run them.
      const naga = await loadNaga()
      for (const shader of world.resource(Shaders).bake().shaders) {
        if (!shader.key.split('|')[1]!.split(',').includes('BASELINE')) continue
        report.variants++
        for (const [stage, entry] of entryPoints(shader.code)) {
          report.entryPoints++
          try {
            naga.translate(shader.code, entry, stage, { clipControl: true })
          } catch (e) {
            add(problemOf(e as ShardError, shader.key))
          }
        }
      }
    } finally {
      p.close()
    }
  } finally {
    gpu.destroy()
  }
  return report
}
