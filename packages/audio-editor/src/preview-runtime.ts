import {
  AudioClips,
  AudioCollection,
  AudioEvent,
  AudioListener,
  AudioMixer,
  AudioSnapshot,
  acquireAudioSnapshot,
  audioClip,
  audioEventsPlugin,
  audioMixerPlugin,
  audioMusicPlugin,
  audioPlugin,
  audioState,
  configureAudioMixer,
  describeAudio,
  MusicProgram,
  playAudioEvent,
  prepareAudio,
  prepareMusic,
  releaseAudioSnapshot,
  setAudioUserBus,
  startMusic,
  stopAudioEvent,
  stopMusic,
} from '@aethervtt/shard-audio'
import {
  type AnyField,
  type AssetRef,
  type Entity,
  type JsonObject,
  ShardError,
} from '@aethervtt/shard-core'
import type { AudioBackend } from '@aethervtt/shard-platform'
import { App } from '@aethervtt/shard-runtime'
import { Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { getAudioEditorSchema, materializeAudioDocument, validateAudioDocument } from './schema'
import type { AudioAssetCatalog, AudioDocument, AudioDocumentStore } from './types'

/** Internal runtime is loaded only by explicit audition, and never opens a project filesystem. */
export async function createPreviewRuntime(options: {
  assets: AudioAssetCatalog
  documents: AudioDocumentStore
  backend?: AudioBackend
  createBackend?: () => AudioBackend
}) {
  const supplied = options.backend
  if (supplied && (!supplied.runtime?.capabilities.sessions || !supplied.createSession))
    throw new ShardError(
      'audio-editor/unsupported-capability',
      'The supplied backend cannot isolate an editor session',
      {
        hint: 'Supply a backend with createSession capability, or let the editor own a browser backend.',
      },
    )
  const backend =
    supplied ??
    options.createBackend?.() ??
    (await import('@aethervtt/shard-platform-web')).createWebAudioBackend()
  let auditionError: ShardError | undefined
  const unlock = () => {
    const failed = (cause: unknown) => {
      auditionError = new ShardError(
        'audio-editor/playback-blocked',
        'Audio output could not resume',
        {
          cause,
          hint: 'Check the host audio device and browser permission, then press Play again.',
        },
      )
    }
    // Browsers may leave resume pending until a later gesture or device becomes available.
    // Runtime ownership and disposal must not wait for that browser promise.
    try {
      const pending = (backend as AudioBackend & { resume?: () => Promise<void> }).resume?.()
      void pending?.then(() => {
        auditionError = undefined
      }, failed)
    } catch (cause) {
      failed(cause)
    }
  }
  // Called synchronously by the preloaded adapter from the user's Play gesture.
  unlock()
  const app = new App().addPlugin(
    TransformPlugin,
    audioPlugin({ backend }),
    audioEventsPlugin(),
    audioMixerPlugin(),
    audioMusicPlugin(),
  )
  try {
    await app.init()
  } catch (error) {
    await app.dispose()
    if (!supplied) backend.dispose?.()
    throw error
  }
  const owned = audioState(app.world).backend
  if (supplied && owned === supplied) {
    await app.dispose()
    throw new ShardError(
      'audio-editor/unsupported-capability',
      'The supplied backend cannot isolate an editor session',
      {
        hint: 'Supply a backend with createSession capability, or let the editor own a browser backend.',
      },
    )
  }
  const events = new Set<number>()
  const emitters = new Map<number, Entity>()
  const listener = app.world.spawn(Transform, AudioListener)
  const music = new Set<number>()
  const snapshots = new Set<number>()
  const releases: (() => void)[] = []
  const removals: (() => void)[] = []
  const definitions = new Map<string, AssetRef>()
  let disposed = false
  let serial = 0
  let last = owned.runtime!.clock.now()
  const tick = () => {
    if (disposed) return
    const now = owned.runtime!.clock.now()
    app.update(Math.max(0, Math.min(0.1, now - last)))
    last = now
  }
  const wake = owned.runtime!.clock.wake(tick, 1 / 60)
  const assertLive = (signal?: AbortSignal) => {
    if (disposed || signal?.aborted)
      throw new ShardError('audio-editor/disposed', 'Audio preview was cancelled')
  }
  const stop = () => {
    for (const id of events) stopAudioEvent(app.world, id, { release: 0 })
    for (const id of music) stopMusic(app.world, id)
    for (const id of snapshots) releaseAudioSnapshot(app.world, id)
    events.clear()
    for (const entity of emitters.values()) app.world.despawn(entity)
    emitters.clear()
    music.clear()
    snapshots.clear()
    while (releases.length) releases.pop()!()
    while (removals.length) removals.pop()!()
    definitions.clear()
    owned.runtime!.collect()
  }

  async function install(document: AudioDocument, signal?: AbortSignal): Promise<AssetRef> {
    const resolved = new Map<string, AssetRef>()
    const pending = new Set<string>()
    const scope = options.assets.scope
    const docsScope = options.documents.scope
    const check = () => {
      assertLive(signal)
      if (scope !== options.assets.scope || docsScope !== options.documents.scope)
        throw new ShardError(
          'audio-editor/asset-unavailable',
          'Host scope changed during preparation',
        )
    }
    async function reference(id: string, type: string): Promise<AssetRef> {
      check()
      const key = `${type}:${id}`
      const existing = resolved.get(key)
      if (existing) return existing
      if (pending.has(key))
        throw new ShardError('audio-editor/invalid-document', 'Cyclic audio document references', {
          path: id,
        })
      if (type !== 'AudioClip') {
        const dependency = id === document.id ? document : await options.documents.read(id, signal)
        if (dependency.type !== type)
          throw new ShardError(
            'audio-editor/invalid-document',
            `Expected ${type}, received ${dependency.type}`,
            { path: id },
          )
        return installDocument(dependency)
      }
      const metadata = await options.assets.get(id, signal)
      check()
      const guid = JSON.stringify([scope, id, metadata.revision])
      const store = app.world.resource(AudioClips)
      const result = { type, guid, path: undefined }
      if (store.has(guid)) {
        resolved.set(key, result)
        return result
      }
      const content = await options.assets.resolve(id, signal)
      try {
        check()
        if (!content.bytes)
          throw new ShardError(
            'audio-editor/unsupported-capability',
            'Audition requires authorized audio bytes',
            {
              path: id,
              hint: 'Have the host resolver return encoded bytes for decoded preview playback.',
            },
          )
        store.set(
          guid,
          audioClip(Uint8Array.from(content.bytes), { ...content.settings, id: guid }),
        )
        removals.push(() => {
          store.delete(guid)
        })
        resolved.set(key, result)
        return result
      } finally {
        content.release?.()
      }
    }
    async function field(field: AnyField, value: unknown): Promise<unknown> {
      if (field.kind === 'handle' && value) {
        const ref = value as AssetRef
        const id = ref.guid ?? ref.path
        if (!id)
          throw new ShardError('audio-editor/asset-unavailable', 'Audio reference has no host ID')
        return reference(id, field.assetType!)
      }
      if (field.kind === 'list' && Array.isArray(value)) {
        const items: unknown[] = []
        for (const item of value) items.push(await fieldValue(field.item!, item))
        return items
      }
      if (field.kind === 'struct') {
        const result = { ...(value as Record<string, unknown>) }
        for (const [name, child] of Object.entries(field.fields!))
          result[name] = await fieldValue(child, result[name])
        return result
      }
      return value
    }
    const fieldValue = field
    async function installDocument(source: AudioDocument): Promise<AssetRef> {
      const key = `${source.type}:${source.id}`
      pending.add(key)
      const schema = getAudioEditorSchema(source.type)
      if (!schema)
        throw new ShardError('audio-editor/unsupported-schema', `Cannot audition ${source.type}`)
      source = await materializeAudioDocument(source, options.documents, signal)
      const { errors } = await validateAudioDocument(
        source,
        options.documents,
        options.assets,
        signal,
      )
      if (errors.length) throw errors[0]
      const value = schema.deserialize(source.value) as Record<string, unknown>
      for (const [name, definition] of Object.entries(schema.fields))
        value[name] = await fieldValue(definition, value[name])
      check()
      const signature = JSON.stringify([docsScope, source.id, source.revision, value])
      const previous = definitions.get(signature)
      if (previous) {
        resolved.set(key, previous)
        pending.delete(key)
        return previous
      }
      if (definitions.size >= 256)
        throw new ShardError('audio/capacity', 'Preview retains at most 256 document revisions', {
          hint: 'Stop audition to release pinned preview revisions before preparing more.',
        })
      const guid = JSON.stringify([docsScope, source.id, source.revision, ++serial])
      const store = app.world.initResource(schema.store)
      store.set(guid, value)
      removals.push(() => {
        store.delete(guid)
      })
      const ref = { type: source.type, guid, path: undefined }
      definitions.set(signature, ref)
      resolved.set(key, ref)
      pending.delete(key)
      return ref
    }
    return installDocument(document)
  }

  return {
    unlock,
    async play(document: AudioDocument, signal?: AbortSignal) {
      assertLive(signal)
      // Resume before the first host read so an existing context receives this user gesture.
      unlock()
      const ref = await install(document, signal)
      assertLive(signal)
      const world = app.world
      if (document.type === AudioEvent.name || document.type === AudioCollection.name) {
        const lease = await prepareAudio(world, ref)
        if (disposed || signal?.aborted) {
          lease.release()
          assertLive(signal)
        }
        releases.push(() => lease.release())
        if (document.type === AudioCollection.name) return { lease: lease.id, prepared: true }
        const entity = world.spawn(Transform)
        const instance = playAudioEvent(world, ref, { entity })
        emitters.set(instance, entity)
        events.add(instance)
        // Event installation is asynchronous even when its dependencies are prepared.
        await Promise.resolve()
        await Promise.resolve()
        tick()
        return { instance }
      }
      if (document.type === MusicProgram.name) {
        const program = await prepareMusic(world, ref)
        try {
          assertLive(signal)
          const transport = startMusic(world, program)
          music.add(transport)
          return { transport }
        } finally {
          program.release()
        }
      }
      if (document.type === AudioMixer.name) {
        await configureAudioMixer(world, ref)
        assertLive(signal)
        return { configured: true }
      }
      if (document.type === AudioSnapshot.name) {
        const snapshot = await acquireAudioSnapshot(world, ref)
        snapshots.add(snapshot)
        return { snapshot }
      }
      return { prepared: true }
    },
    command(name: string, params: Record<string, unknown>) {
      assertLive()
      if (name === 'audio.user.set') {
        if (typeof params.bus !== 'string')
          throw new ShardError('audio-editor/invalid-document', 'User category requires a bus name')
        setAudioUserBus(app.world, params.bus, params as { volume?: number; muted?: boolean })
        return { updated: true }
      }
      if (name === 'audio.listener.set' || name === 'audio.emitter.set') {
        const position = params.position
        if (
          !Array.isArray(position) ||
          position.length !== 3 ||
          position.some((value) => typeof value !== 'number' || !Number.isFinite(value))
        )
          throw new ShardError(
            'audio-editor/invalid-document',
            'Position requires three finite coordinates',
            { path: '/position' },
          )
        const entity =
          name === 'audio.listener.set' ? listener : emitters.get(Number(params.instance))
        if (entity === undefined)
          throw new ShardError(
            'audio-editor/invalid-document',
            'This preview does not own the emitter',
          )
        app.world.set(entity, Transform, { translation: position as [number, number, number] })
        tick()
        return { updated: true }
      }
      const method = app.methods.find((item) => item.name === name)
      if (!method || !name.startsWith('audio.'))
        throw new ShardError('audio-editor/unsupported-capability', `Unknown audio command ${name}`)
      // Asset-bearing commands must use play() and the host resolver.
      if (
        [
          'audio.play',
          'audio.prepare',
          'audio.music.start',
          'audio.snapshot.acquire',
          'audio.preview',
        ].includes(name)
      )
        throw new ShardError(
          'audio-editor/unsupported-capability',
          'Use editor audition to resolve host assets',
        )
      const errors = method.params.validate(params as JsonObject)
      if (errors.length) throw errors[0]
      return method.handler(
        { app, world: app.world },
        method.params.deserialize(params as JsonObject),
      )
    },
    inspect() {
      assertLive()
      tick()
      // Backend presentation records mutate on stop; editor observations are snapshots.
      return {
        ...structuredClone(describeAudio(app.world)),
        ...(auditionError ? { auditionError: auditionError.toJSON() } : {}),
      }
    },
    stop,
    dispose() {
      if (disposed) return
      stop()
      disposed = true
      wake()
      // Disconnect synchronously; App disposal also tears down plugin state asynchronously.
      owned.dispose?.()
      const closing = app.dispose()
      if (!supplied) backend.dispose?.()
      return closing
    },
  }
}
