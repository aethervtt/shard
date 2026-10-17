import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  AudioClips,
  AudioCollection,
  AudioEvent,
  AudioMixer,
  AudioParameters,
  AudioPreviewHost,
  AudioPreviewPlan,
  type AudioPreviewPlanValue,
  AudioSnapshot,
  MusicProgram,
  validateAudioPreview,
} from '@aethervtt/shard-audio'
import { type AssetRef, ShardError } from '@aethervtt/shard-core'
import { openProject } from '@aethervtt/shard-node'
import { DEFAULT_HUB_PORT } from '@aethervtt/shard-protocol'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import type { CommandContext } from './commands'
import { openProjectAssets } from './commands'
import { Hub, localTarget } from './hub'
import { EXIT } from './output'
import { attached } from './profile'

/** Preserve shared encoded-buffer identity across the browser boundary. */
function serializeBytes(value: unknown) {
  const bytes: string[] = [],
    ids = new Map<Uint8Array, number>()
  function encode(value: unknown): unknown {
    if (value instanceof Uint8Array) {
      let id = ids.get(value)
      if (id === undefined) {
        id = bytes.length
        ids.set(value, id)
        bytes.push(Buffer.from(value).toString('base64'))
      }
      return { $audioBytes: id }
    }
    if (Array.isArray(value)) return value.map(encode)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)]))
  }
  return { value: encode(value), bytes }
}

export async function renderProjectAudio(
  project: string,
  plan: AudioPreviewPlanValue,
  output: string,
  source = 'inline',
) {
  validateAudioPreview(plan)
  const { server: assets, world, platform } = await openProjectAssets(project)
  try {
    await assets.scan()
    const packed: { guid: string; path: string; type: string; value: unknown }[] = []
    const seen = new Set<string>(),
      buffers = new Set<Uint8Array>()
    let encodedBytes = 0,
      decodedBytes = 0
    async function visit(ref: AssetRef) {
      const resolved = assets.resolve(ref.guid ?? ref.path ?? '')
      if (!resolved?.guid)
        throw new ShardError(
          'audio/preview-unavailable',
          `Unknown preview asset ${ref.path ?? ref.guid}`,
        )
      if (seen.has(resolved.guid)) return resolved
      seen.add(resolved.guid)
      if (seen.size > 512)
        throw new ShardError('audio/memory-budget', 'Preview dependency count exceeds 512')
      await assets.load(resolved)
      const store =
        resolved.type === 'AudioClip'
          ? AudioClips
          : resolved.type === 'audio/AudioEvent'
            ? AudioEvent.store
            : resolved.type === 'audio/AudioCollection'
              ? AudioCollection.store
              : resolved.type === 'audio/AudioMixer'
                ? AudioMixer.store
                : resolved.type === 'audio/AudioParameters'
                  ? AudioParameters.store
                  : resolved.type === 'audio/AudioSnapshot'
                    ? AudioSnapshot.store
                    : resolved.type === 'audio/MusicProgram'
                      ? MusicProgram.store
                      : null
      if (!store)
        throw new ShardError(
          'audio/preview-unavailable',
          `Unsupported preview dependency ${resolved.type}`,
        )
      const value = world.initResource(store as typeof AudioClips).get(resolved)
      if (!value)
        throw new ShardError('audio/preview-unavailable', 'Preview dependency did not load')
      if (resolved.type === 'AudioClip') {
        const clip = value as import('@aethervtt/shard-audio').AudioClipAsset
        if (clip.stream || !clip.bytes.byteLength)
          throw new ShardError('audio/preview-unavailable', 'Preview requires local decoded clips')
        if (!buffers.has(clip.bytes)) {
          buffers.add(clip.bytes)
          encodedBytes += clip.bytes.byteLength
          decodedBytes += Math.ceil(clip.duration * plan.sampleRate) * (clip.channels ?? 2) * 4
        }
        if (encodedBytes > 64 * 1024 * 1024 || decodedBytes > 64 * 1024 * 1024)
          throw new ShardError(
            'audio/memory-budget',
            'Preview dependencies exceed the 64 MiB input/PCM budget',
          )
      } else await dependencies(value)
      packed.push({
        guid: resolved.guid,
        path: resolved.path ?? resolved.guid,
        type: resolved.type!,
        value,
      })
      return resolved
    }
    async function dependencies(value: unknown): Promise<void> {
      if (Array.isArray(value)) {
        for (const item of value) await dependencies(item)
        return
      }
      if (!value || typeof value !== 'object' || value instanceof Uint8Array) return
      const item = value as Record<string, unknown>
      if (
        (typeof item.guid === 'string' || typeof item.path === 'string') &&
        typeof item.type === 'string'
      ) {
        const resolved = await visit(item as unknown as AssetRef)
        Object.assign(item, resolved)
      } else for (const child of Object.values(item)) await dependencies(child)
    }
    await dependencies(plan)
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
          serializeBytes({ plan, assets: packed }),
        )
        const out = resolve(project, output),
          evidencePath = `${out}.json`
        await mkdir(dirname(out), { recursive: true })
        await writeFile(out, Buffer.from(result.wav, 'base64'))
        const evidence = {
          plan: source,
          seed: plan.seed,
          inputs: { assets: packed.length, encodedBytes, estimatedDecodedBytes: decodedBytes },
          measured: result.measured,
          trace: result.trace,
          backend: result.backend,
          capabilities: result.capabilities,
        }
        await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
        return { out, evidencePath, ...evidence }
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

export async function audioCommand(ctx: CommandContext): Promise<number> {
  const [mode, file] = ctx.args
  if (mode !== 'preview') return audioCall(ctx)
  if (!file)
    throw new ShardError('cli/usage', 'Usage: shard audio preview plan.json --out mix.wav --json')
  const plan = AudioPreviewPlan.deserialize(
    JSON.parse(await readFile(resolve(ctx.project, file), 'utf8')),
  )
  const result = await renderProjectAudio(
    ctx.project,
    plan,
    String(ctx.flags.out ?? 'mix.wav'),
    file,
  )
  ctx.out.result(result, `Rendered ${result.out}\nEvidence: ${result.evidencePath}`)
  return EXIT.ok
}
/** A protocol target is one engine session. Persistent mutations need --attach. */
async function audioCall(ctx: CommandContext): Promise<number> {
  const [mode, name] = ctx.args
  const method = mode === 'call' ? name : `audio.${mode}`
  if (!method?.startsWith('audio.'))
    throw new ShardError(
      'cli/usage',
      'Usage: shard audio call audio.<method> --params <json> [--attach]',
    )
  let params: unknown
  try {
    params = JSON.parse(String(ctx.flags.params ?? '{}'))
  } catch (cause) {
    throw new ShardError('cli/usage', '--params must be a JSON object', { cause })
  }
  if (ctx.flags.attach) {
    const hub = new Hub()
    try {
      await hub.start(Number(ctx.flags.port ?? process.env.SHARD_HUB_PORT ?? DEFAULT_HUB_PORT))
      const target = await attached(hub)
      ctx.out.result(await target.request(method, params))
    } finally {
      hub.close()
    }
  } else {
    const project = await openProject({ root: ctx.project })
    try {
      project.app.world.insertResource(AudioPreviewHost, (plan, out) =>
        renderProjectAudio(ctx.project, plan, out),
      )
      ctx.out.result(await localTarget('headless', project.server).request(method, params))
    } finally {
      project.close()
    }
  }
  return EXIT.ok
}
