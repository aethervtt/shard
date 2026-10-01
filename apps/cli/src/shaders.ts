import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { type ShardError, ShardError as ShardErrorClass } from '@aethervtt/shard-core'
import { GpuContext } from '@aethervtt/shard-gpu'
import { nodeGpu } from '@aethervtt/shard-gpu/node'
import {
  type BakedTranslations,
  entryPointOf,
  type GlslStage,
  loadNaga,
  NAGA_VERSION,
  SHIM_VERSION,
  translationKey,
} from '@aethervtt/shard-gpu-webgl2'
import { openProject } from '@aethervtt/shard-node'
import { Shaders, type ShaderVariantManifest, showVariants } from '@aethervtt/shard-render'
import { loadScene, unloadScene, whenSceneReady } from '@aethervtt/shard-scene'

// `shard shaders bake` (0064): the WebGL2 translation cache a project ships, so a WebGL2 session
// neither downloads naga nor translates at load. It runs the project's scenes headless at the
// baseline tier, then `shaders.variants.json`'s entries, records every pipeline stage they make,
// and translates each with naga for devices with and without EXT_clip_control.

export const DEFAULT_BAKE_OUT = '.shard/shaders/webgl2.json'
export const VARIANT_MANIFEST = 'shaders.variants.json'

export interface ShaderBakeReport {
  /** Where the set was written: relative to the project, or absolute, as given. */
  out: string
  scenes: string[]
  /** The manifest's entries and the variants they showed, if there was a manifest. */
  manifest: { file: string; entries: number; variants: number } | undefined
  /** Distinct (WGSL, entry point, stage) the run made pipelines of. */
  stages: number
  /** Translations written: each stage twice, with and without clip control. */
  translations: number
  bytes: number
  /** What couldn't be shown or translated. */
  failed: { label: string; entry?: string; stage?: GlslStage; code: string; message: string }[]
}

/** Frames each scene draws: enough for pipelines to compile and deferred work to run. */
const FRAMES = 30

interface RecordedStage {
  code: string
  entry: string
  stage: GlslStage
  label: string
}

/**
 * The baseline tier as most WebGL2 devices run it: HDR targets multisample 4× (so the depth
 * prepass runs too), on a core Dawn device; what's recorded is the WGSL the engine asks for.
 */
async function webgl2LikeContext(): Promise<GpuContext> {
  const gpu = nodeGpu()
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' })
  if (!adapter) throw new ShardErrorClass('cli/no-gpu', 'No GPU adapter to bake shaders on')
  const wanted: GPUFeatureName[] = ['rg11b10ufloat-renderable', 'float32-filterable']
  const device = await adapter.requestDevice({
    label: 'shard-bake',
    requiredFeatures: wanted.filter((f) => adapter.features.has(f)),
  })
  return new GpuContext({ gpu }, adapter, device, 'rgba8unorm', {
    tier: 'baseline',
    hdrSampleCount: 4,
  })
}

/** Records every render pipeline stage the device is asked for. */
function record(device: GPUDevice, stages: Map<string, RecordedStage>): void {
  const sources = new WeakMap<GPUShaderModule, string>()
  const createShaderModule = device.createShaderModule.bind(device)
  device.createShaderModule = (d) => {
    const module = createShaderModule(d)
    sources.set(module, d.code)
    return module
  }
  const add = (
    module: GPUShaderModule,
    entry: string | undefined,
    stage: GlslStage,
    label: string,
  ) => {
    const code = sources.get(module)
    if (code === undefined) return
    const name = entry ?? entryPointOf(code, stage)
    const key = `${stage}|${name}|${code}`
    if (!stages.has(key)) stages.set(key, { code, entry: name, stage, label })
  }
  const seen = (d: GPURenderPipelineDescriptor) => {
    const label = d.label ?? 'unlabeled pipeline'
    add(d.vertex.module, d.vertex.entryPoint, 'vertex', label)
    if (d.fragment) add(d.fragment.module, d.fragment.entryPoint, 'fragment', label)
  }
  const createRenderPipeline = device.createRenderPipeline.bind(device)
  device.createRenderPipeline = (d) => {
    seen(d)
    return createRenderPipeline(d)
  }
  const createRenderPipelineAsync = device.createRenderPipelineAsync.bind(device)
  device.createRenderPipelineAsync = (d) => {
    seen(d)
    return createRenderPipelineAsync(d)
  }
}

/** Bakes `scenes` (relative to `root`) and the manifest, if any, into `out`. */
export async function bakeShaders(
  root: string,
  scenes: readonly string[],
  options: { manifest?: string; out?: string } = {},
): Promise<ShaderBakeReport> {
  const out = options.out ?? DEFAULT_BAKE_OUT
  const manifestFile =
    options.manifest ?? (existsSync(join(root, VARIANT_MANIFEST)) ? VARIANT_MANIFEST : undefined)
  const report: ShaderBakeReport = {
    out,
    scenes: [],
    manifest: undefined,
    stages: 0,
    translations: 0,
    bytes: 0,
    failed: [],
  }
  const gpu = await webgl2LikeContext()
  const stages = new Map<string, RecordedStage>()
  record(gpu.device, stages)
  try {
    const p = await openProject({
      root,
      gpu,
      loadStartScene: false,
      generatorWorkers: false,
      code: 'source',
    })
    try {
      const world = p.app.world
      const settle = async () => {
        await world.resource(Shaders).whenIdle()
        await gpu.pipelines.whenIdle()
      }
      for (const path of scenes) {
        report.scenes.push(path)
        loadScene(world, JSON.parse(await p.platform.fs.readText(path)), { id: path })
        await whenSceneReady(world, path)
        for (let i = 0; i < FRAMES; i++) {
          p.app.update(1 / p.app.fixedHz)
          await settle()
        }
        unloadScene(world, path)
        p.app.update(1 / p.app.fixedHz)
      }
      if (manifestFile) {
        const manifest = JSON.parse(
          await readFile(resolve(root, manifestFile), 'utf8'),
        ) as ShaderVariantManifest
        report.manifest = { file: manifestFile, entries: 0, variants: 0 }
        for (const entry of manifest.variants ?? []) {
          report.manifest.entries++
          try {
            report.manifest.variants += await showVariants(p.app, entry)
          } catch (err) {
            const e = err as ShardError
            report.failed.push({
              label: `${manifestFile} ${JSON.stringify(entry)}`,
              code: e.code ?? 'cli/bake',
              message: e.message,
            })
          }
          await settle()
        }
      }
    } finally {
      p.close()
    }
  } finally {
    gpu.destroy()
  }

  const naga = await loadNaga()
  const set: BakedTranslations = {
    format: 'shard-webgl2-glsl',
    naga: NAGA_VERSION,
    shim: SHIM_VERSION,
    entries: {},
  }
  report.stages = stages.size
  for (const s of stages.values()) {
    for (const clipControl of [true, false]) {
      try {
        set.entries[translationKey(s.code, s.entry, s.stage, clipControl)] = naga.translate(
          s.code,
          s.entry,
          s.stage,
          { clipControl },
        )
        report.translations++
      } catch (err) {
        const e = err as ShardError
        report.failed.push({
          label: s.label,
          entry: s.entry,
          stage: s.stage,
          code: e.code ?? 'gpu-webgl2/translate',
          message: e.message,
        })
        break
      }
    }
  }
  const json = JSON.stringify(set)
  report.bytes = Buffer.byteLength(json)
  // resolve, not join: an absolute --out stays absolute rather than landing under the project.
  const file = resolve(root, out)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, json)
  return report
}
