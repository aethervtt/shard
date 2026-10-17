import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  AudioBuses,
  type AudioClipAsset,
  AudioClips,
  AudioMixState,
  AudioPreviewPlan,
  AudioState,
  configureAudioMixer,
  createAudioState,
  HeadlessAudioBackend,
  validateAudioPreview,
} from '@aethervtt/shard-audio'
import { ShardError } from '@aethervtt/shard-core'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import type { CommandContext } from './commands'
import { openProjectAssets } from './commands'
import { EXIT } from './output'

function serializeBytes(value: unknown): unknown {
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64')
  if (Array.isArray(value)) return value.map(serializeBytes)
  if (!value || typeof value !== 'object') return value
  const object = value as Record<string, unknown>,
    result: Record<string, unknown> = {}
  for (const key in object)
    result[key === 'bytes' ? 'bytesBase64' : key] = serializeBytes(object[key])
  return result
}

export async function audioCommand(ctx: CommandContext): Promise<number> {
  const [mode, file] = ctx.args
  if (mode !== 'preview' || !file)
    throw new ShardError('cli/usage', 'Usage: shard audio preview plan.json --out mix.wav --json')
  const plan = AudioPreviewPlan.deserialize(
    JSON.parse(await readFile(resolve(ctx.project, file), 'utf8')),
  )
  validateAudioPreview(plan)
  const { server: assets, world, platform } = await openProjectAssets(ctx.project)
  try {
    await assets.scan()
    const resolvedClips = new Map<string, AudioClipAsset>()
    let encodedBytes = 0
    for (const entry of plan.clips) {
      await assets.load(entry.asset!)
      const clip = world.resource(AudioClips).get(entry.asset)
      if (!clip || clip.stream)
        throw new ShardError(
          'audio/preview-unavailable',
          'Preview requires decoded local clip assets',
        )
      encodedBytes += clip.bytes.byteLength
      if (encodedBytes > 64 * 1024 * 1024)
        throw new ShardError('audio/memory-budget', 'Preview input exceeds 64 MiB')
      resolvedClips.set(entry.id, clip)
    }
    let mixer: import('@aethervtt/shard-audio').AudioMixStateValue['graph'] | undefined
    if (plan.mixer) {
      // The project host installs the authored mixer plugin when its manifest enables it.
      world.initResource(AudioBuses)
      world.insertResource(AudioState, createAudioState(new HeadlessAudioBackend()))
      world.insertResource(AudioMixState, {
        definition: null,
        graph: null,
        fields: [],
        snapshots: [],
        nextId: 1,
        revision: 0,
        maxNodes: 2048,
        userSent: new Float64Array(0),
        globals: null,
        globalKey: '',
        curves: [],
        scratch: new Float64Array(1),
      })
      await configureAudioMixer(world, plan.mixer)
      mixer = world.resource(AudioMixState).graph ?? undefined
    }
    const renderPlan = {
      duration: plan.duration,
      tailSeconds: plan.tailSeconds,
      sampleRate: plan.sampleRate,
      channels: plan.channels,
      mixer,
      voices: plan.voices.map((voice) => ({
        clip: resolvedClips.get(voice.clip)!,
        bus: voice.bus,
        when: voice.at,
        duration: voice.duration || undefined,
        offset: voice.offset,
        loop: voice.loop,
        gain: 10 ** (voice.gainDb / 20),
        pitch: voice.pitch,
        x: voice.position[0],
        y: voice.position[1],
        z: voice.position[2],
        spatial: voice.spatial
          ? {
              panning: 'equal-power',
              distanceModel: 'inverse',
              refDistance: voice.minDistance,
              maxDistance: voice.maxDistance,
              rolloffFactor: 1,
            }
          : null,
      })),
      automation: plan.automation.map((command) => ({
        voice: plan.voices.findIndex((voice) => voice.id === command.voice),
        command,
      })),
    }
    const root = join(import.meta.dirname, '../runner')
    const server = await createServer({
      root,
      configFile: false,
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0 },
    })
    try {
      await server.listen()
      const browser = await chromium.launch({ headless: true }).catch((cause: unknown) => {
        throw new ShardError(
          'audio/preview-unavailable',
          'Chromium is required for offline audio rendering',
          { cause, hint: 'Run pnpm exec playwright install chromium in apps/cli.' },
        )
      })
      try {
        const page = await browser.newPage()
        await page.goto(`${server.resolvedUrls!.local[0]}audio-preview.html`)
        await page.waitForFunction(() => 'previewAudio' in globalThis)
        const result = await page.evaluate(
          async (payload) =>
            (
              globalThis as unknown as {
                previewAudio(plan: unknown): Promise<{
                  wav: string
                  measured: unknown
                  trace: unknown
                  backend: unknown
                  capabilities: unknown
                }>
              }
            ).previewAudio(payload),
          serializeBytes(renderPlan),
        )
        const out = resolve(ctx.project, String(ctx.flags.out ?? 'mix.wav')),
          trace = `${out}.json`
        await mkdir(dirname(out), { recursive: true })
        await writeFile(out, Buffer.from(result.wav, 'base64'))
        const evidence = {
          plan: file,
          seed: plan.seed,
          measured: result.measured,
          trace: result.trace,
          backend: result.backend,
          capabilities: result.capabilities,
        }
        await writeFile(trace, `${JSON.stringify(evidence, null, 2)}\n`)
        ctx.out.result(
          { out, evidencePath: trace, ...evidence },
          `Rendered ${out}\nEvidence: ${trace}`,
        )
        return EXIT.ok
      } finally {
        await browser.close()
      }
    } finally {
      await server.close()
    }
  } finally {
    platform.workers?.dispose()
  }
}
