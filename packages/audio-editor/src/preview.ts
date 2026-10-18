import { type JsonObject, ShardError } from '@aethervtt/shard-core'
import type { AudioBackend } from '@aethervtt/shard-platform'
import { validateAudioDocument } from './schema'
import type {
  AudioAssetCatalog,
  AudioDocument,
  AudioDocumentStore,
  AudioPreviewAdapter,
} from './types'
import { type AudioWaveformDecoder, createAudioWaveformCache } from './waveform'

export interface IsolatedAudioPreviewOptions {
  assets: AudioAssetCatalog
  documents: AudioDocumentStore
  /** Borrowed host root. It must support isolated sessions; the root is never closed. */
  backend?: AudioBackend
  waveformDecoder?: AudioWaveformDecoder
  waveformBytes?: number
  /** The host implements the existing audio preview render-plan/export capability. */
  export?(document: AudioDocument, plan: JsonObject, signal?: AbortSignal): Promise<unknown>
}

/** Silent construction. Engine/platform implementation loads only on explicit Play. */
export function createIsolatedAudioPreview(
  options: IsolatedAudioPreviewOptions,
): AudioPreviewAdapter {
  type Runtime = Awaited<ReturnType<typeof import('./preview-runtime').createPreviewRuntime>>
  let runtime: Runtime | undefined
  let opening: Promise<Runtime> | undefined
  let disposed = false
  let scope = JSON.stringify([options.assets.scope, options.documents.scope])
  let controller = new AbortController()
  // Loading code is silent; no context, backend, clock or listeners exist until Play.
  let factory: typeof import('./preview-runtime').createPreviewRuntime | undefined
  let createBackend: (() => AudioBackend) | undefined
  const preload = Promise.all([
    import('./preview-runtime'),
    import('@aethervtt/shard-platform-web'),
  ]).then(([runtimeModule, platform]) => {
    factory = runtimeModule.createPreviewRuntime
    createBackend = platform.createWebAudioBackend
  })
  void preload.catch(() => {})
  const waveforms = createAudioWaveformCache(options.assets, {
    decode: options.waveformDecoder,
    maxBytes: options.waveformBytes,
  })
  const canExport =
    !!options.export ||
    (typeof OfflineAudioContext !== 'undefined' &&
      typeof OfflineAudioContext.prototype.suspend === 'function' &&
      typeof OfflineAudioContext.prototype.resume === 'function')
  const assertLive = (signal?: AbortSignal) => {
    if (disposed || signal?.aborted)
      throw new ShardError('audio-editor/disposed', 'Audio audition is closed or cancelled', {
        hint: 'Use an active editor preview session.',
      })
  }
  const reset = () => {
    controller.abort()
    controller = new AbortController()
    runtime?.dispose()
    runtime = undefined
    opening = undefined
    waveforms.clear()
  }
  const checkScope = () => {
    const current = JSON.stringify([options.assets.scope, options.documents.scope])
    if (scope !== current) {
      reset()
      scope = current
    }
  }
  const invalidate = () => {
    const current = JSON.stringify([options.assets.scope, options.documents.scope])
    if (current !== scope) {
      reset()
      scope = current
      return
    }
    // Existing voices pin their resolved revisions. A catalog edit cancels preparations
    // and exports, while subsequent plays resolve fresh metadata in the same runtime.
    controller.abort()
    controller = new AbortController()
    opening = undefined
    waveforms.clear()
  }
  const unsubscribe = options.assets.subscribe?.(invalidate)
  const unsubscribeDocuments = options.documents.subscribe?.(invalidate)
  async function ensure(signal?: AbortSignal) {
    assertLive(signal)
    checkScope()
    if (runtime) return runtime
    if (!opening) {
      const token = controller.signal
      const start = async () => {
        assertLive(token)
        const value = await factory!({ ...options, createBackend })
        if (disposed || token.aborted) {
          value.dispose()
          assertLive(token)
        }
        runtime = value
        return value
      }
      opening = (factory ? start() : preload.then(start)).catch((error: unknown) => {
        if (!token.aborted) opening = undefined
        throw error
      })
    }
    return opening
  }
  return {
    mode: 'audition',
    capabilities: {
      play: true,
      control: true,
      drafts: true,
      waveform: true,
      listener: true,
      emitter: true,
      userControls: true,
      export: canExport,
    },
    async play(document, signal) {
      assertLive(signal)
      checkScope()
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
      // An existing browser context must receive resume before any async host validation.
      runtime?.unlock()
      const pending = ensure(combined)
      void pending.catch(() => {})
      const result = await validateAudioDocument(
        document,
        options.documents,
        options.assets,
        combined,
      )
      assertLive(combined)
      if (result.errors.length) throw result.errors[0]
      const active = await pending
      assertLive(combined)
      return active.play(result.effective ?? document, combined)
    },
    stop() {
      assertLive()
      controller.abort()
      controller = new AbortController()
      opening = undefined
      runtime?.stop()
    },
    inspect() {
      assertLive()
      checkScope()
      return runtime?.inspect() ?? { mode: 'audition', state: 'idle', owned: true }
    },
    async command(name, params) {
      return (await ensure()).command(name, params)
    },
    waveform(id, bins, signal) {
      assertLive(signal)
      checkScope()
      return waveforms.get(id, bins, signal)
    },
    ...(canExport
      ? {
          async export(document: AudioDocument, plan: JsonObject, signal?: AbortSignal) {
            assertLive(signal)
            checkScope()
            const combined = signal
              ? AbortSignal.any([signal, controller.signal])
              : controller.signal
            const result = await validateAudioDocument(
              document,
              options.documents,
              options.assets,
              combined,
            )
            assertLive(combined)
            if (result.errors.length) throw result.errors[0]
            if (options.export) return options.export(result.effective ?? document, plan, combined)
            const { exportAudioEditorPreview } = await import('./preview-export')
            assertLive(combined)
            return exportAudioEditorPreview(options, result.effective ?? document, plan, combined)
          },
        }
      : {}),
    dispose() {
      if (disposed) return
      disposed = true
      reset()
      unsubscribe?.()
      unsubscribeDocuments?.()
      waveforms.dispose()
    },
  }
}

export interface AttachedAudioPreviewOptions {
  target: string
  call(name: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
  liveControl?: boolean
  /** Explicit host capability; absence never causes an implicit save. */
  applyDraft?(document: AudioDocument, signal?: AbortSignal): Promise<string>
}

const inspection = new Set([
  'audio.describe',
  'audio.events.inspect',
  'audio.mix.inspect',
  'audio.music.inspect',
  'audio.meters',
  'audio.log',
])

/** Protocol bridge has no privilege to close the target or stop its unrelated instances. */
export function createAttachedAudioPreview(
  options: AttachedAudioPreviewOptions,
): AudioPreviewAdapter {
  const ownedEvents = new Set<number>()
  const ownedMusic = new Set<number>()
  const ownedSnapshots = new Set<number>()
  let disposed = false
  let controller = new AbortController()
  const assertLive = () => {
    if (disposed) throw new ShardError('audio-editor/disposed', 'Runtime attachment is closed')
  }
  const requireControl = () => {
    assertLive()
    if (!options.liveControl)
      throw new ShardError(
        'audio-editor/read-only',
        `Attachment ${options.target} permits inspection only`,
        { hint: 'The host must explicitly grant live audio control.' },
      )
  }
  const stop = async () => {
    controller.abort()
    controller = new AbortController()
    for (const instance of ownedEvents) await options.call('audio.stop', { instance, release: 0 })
    for (const transport of ownedMusic) await options.call('audio.music.stop', { transport })
    for (const snapshot of ownedSnapshots)
      await options.call('audio.snapshot.release', { snapshot })
    ownedEvents.clear()
    ownedMusic.clear()
    ownedSnapshots.clear()
  }
  return {
    mode: 'attached',
    target: options.target,
    capabilities: {
      play: !!options.liveControl && !!options.applyDraft,
      control: !!options.liveControl,
      drafts: !!options.applyDraft,
      waveform: false,
      export: false,
    },
    async play(document, signal) {
      requireControl()
      if (!options.applyDraft)
        throw new ShardError(
          'audio-editor/unsupported-capability',
          'This attachment cannot apply unsaved drafts',
          { hint: 'Use isolated audition, or supply a host draft-apply capability.' },
        )
      const method =
        document.type === 'audio/AudioEvent'
          ? 'audio.play'
          : document.type === 'audio/MusicProgram'
            ? 'audio.music.start'
            : document.type === 'audio/AudioSnapshot'
              ? 'audio.snapshot.acquire'
              : undefined
      if (!method)
        throw new ShardError(
          'audio-editor/unsupported-capability',
          'This document type has no attached play command',
        )
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
      const asset = await options.applyDraft(document, combined)
      if (combined.aborted)
        throw new ShardError('audio-editor/disposed', 'Draft attachment was cancelled')
      assertLive()
      const result = (await options.call(
        method,
        method === 'audio.play' ? { event: asset } : { asset },
        combined,
      )) as Record<string, unknown>
      if (disposed || combined.aborted) {
        if (typeof result.instance === 'number')
          await options.call('audio.stop', { instance: result.instance, release: 0 })
        if (typeof result.transport === 'number')
          await options.call('audio.music.stop', { transport: result.transport })
        if (typeof result.snapshot === 'number')
          await options.call('audio.snapshot.release', { snapshot: result.snapshot })
        throw new ShardError('audio-editor/disposed', 'Attached playback was cancelled')
      }
      if (typeof result.instance === 'number') ownedEvents.add(result.instance)
      if (typeof result.transport === 'number') ownedMusic.add(result.transport)
      if (typeof result.snapshot === 'number') ownedSnapshots.add(result.snapshot)
      return result
    },
    stop,
    async inspect() {
      assertLive()
      return {
        target: options.target,
        mode: 'attached',
        control: !!options.liveControl,
        audio: await options.call('audio.describe', {}, controller.signal),
      }
    },
    async command(name, params) {
      assertLive()
      if (!inspection.has(name)) {
        requireControl()
        const event = Number(params.instance)
        const music = Number(params.transport)
        const snapshot = Number(params.snapshot)
        const allowed =
          (['audio.stop', 'audio.parameter.set'].includes(name) && ownedEvents.has(event)) ||
          ([
            'audio.music.parameter',
            'audio.music.transition',
            'audio.music.stinger',
            'audio.music.pause',
            'audio.music.resume',
            'audio.music.seek',
            'audio.music.cancel',
            'audio.music.stop',
          ].includes(name) &&
            ownedMusic.has(music)) ||
          (['audio.snapshot.set', 'audio.snapshot.release'].includes(name) &&
            ownedSnapshots.has(snapshot))
        if (!allowed)
          throw new ShardError(
            'audio-editor/unsupported-capability',
            'Command is outside this editor attachment’s owned instances',
          )
      }
      return options.call(name, params, controller.signal)
    },
    async dispose() {
      if (disposed) return
      disposed = true
      controller.abort()
      await stop()
    },
  }
}
