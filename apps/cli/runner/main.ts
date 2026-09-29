/**
 * The page `shard dev` serves: loads the engine, fetches the project bundle, runs the project with
 * a canvas and DOM input, and dials the dev server's hub so tools (and hot reload) can reach it.
 */
import { assetServer } from '@aethervtt/shard-assets'
import { ShardError } from '@aethervtt/shard-core'
import { createDomInputSource, createWebPlatform } from '@aethervtt/shard-platform-web'
import { configureProcgenHost, setGeneratorCodeHashes } from '@aethervtt/shard-procgen'
import {
  buildApp,
  inlineSourceMap,
  loadProjectNavCache,
  loadProjectStrings,
  locateInBundle,
  type ManifestValue,
  ProjectSession,
  type SourceMap,
} from '@aethervtt/shard-project'
import { connectToHub, createProtocolServer } from '@aethervtt/shard-protocol'
import { Shaders } from '@aethervtt/shard-render'
import { animationFrameRunner, LogResource, type Plugin } from '@aethervtt/shard-runtime'
import { loadScene, whenSceneReady } from '@aethervtt/shard-scene'
import { metricsPlugin } from '@aethervtt/shard-verify/metrics'
import { installCapturePage } from '@aethervtt/shard-verify/page'

interface DevInfo {
  manifest: ManifestValue
  bundle: string
  /** Generators' code hashes, and the worker bundle their jobs run in. */
  procgen?: DevGenerators
  hub: string
}

interface DevGenerators {
  codeHashes: Record<string, string>
  worker?: string
}

/** Before project code (re)loads: its generators' hashes, and jobs on this page's web workers. */
function useGenerators(
  g: DevGenerators | undefined,
  workers: Parameters<typeof configureProcgenHost>[0]['workers'],
): void {
  if (!g) return
  setGeneratorCodeHashes(g.codeHashes)
  if (g.worker && workers) {
    configureProcgenHost({ workers, workerModule: new URL(g.worker, location.href).href })
  }
}

const canvas = document.getElementById('viewport') as HTMLCanvasElement
const status = document.getElementById('status') as HTMLElement

function show(message: string, error = false) {
  status.textContent = message
  status.classList.toggle('error', error)
}

/** Source maps of loaded bundles, by URL, so errors point at project files. */
const maps = new Map<string, SourceMap>()
async function mapFor(url: string): Promise<void> {
  if (maps.has(url)) return
  const map = inlineSourceMap(await (await fetch(url)).text())
  if (map) maps.set(url, map)
}
const toProjectPath = (s: string) => s.replace(/^(\.\.\/)+/, '')

async function start() {
  const info = (await (await fetch('/@aethervtt/shard-project.json')).json()) as DevInfo
  const { manifest } = info
  document.title = `${manifest.name} · shard dev`
  // Saves and settings: one IndexedDB database per project.
  const platform = createWebPlatform({
    baseUrl: `${location.origin}/@aethervtt/shard-files/`,
    storageName: `shard:${manifest.name}`,
  })

  useGenerators(info.procgen, platform.workers)
  await mapFor(info.bundle)
  const project = (await import(/* @vite-ignore */ info.bundle)).default as Plugin
  const app = buildApp({
    manifest,
    project,
    canvas,
    inputSource: createDomInputSource(canvas),
    audio: manifest.plugins.includes('audio') ? platform.audio : undefined,
    platform,
  })
  // Performance records over the protocol (metrics.record), the same way scripts take them (0062).
  app.addPlugin(metricsPlugin({ performance: platform.performance }))
  await app.init()
  await loadProjectNavCache(app, platform)

  // Project shaders: shaders/water/foam.wesl is project::water::foam.
  const shaders = app.world.resource(Shaders)
  const registerShader = ({ file, source }: { file: string; source: string }) => {
    const module = `project::${file
      .replace(/^shaders\//, '')
      .replace(/\.(wesl|wgsl)$/, '')
      .split('/')
      .join('::')}`
    try {
      shaders.register(module, source, file)
    } catch (err) {
      app.world.resource(LogResource).error(err)
    }
  }
  for (const shader of (await (await fetch('/@aethervtt/shard-shaders.json')).json()) as {
    file: string
    source: string
  }[])
    registerShader(shader)
  import.meta.hot?.on('shard:shader', registerShader)

  const log = app.world.resource(LogResource)
  log.annotate = (err) => {
    for (
      let e: unknown = err, depth = 0;
      e && depth < 5;
      e = (e as { cause?: unknown }).cause, depth++
    ) {
      for (const [url, map] of maps) {
        const source = locateInBundle(e, new URL(url, location.origin).href, map, toProjectPath)
        if (source) return { source }
      }
    }
    return undefined
  }

  const assets = assetServer(app.world).configure({ platform, roots: manifest.assetRoots })
  await assets.scan()
  await loadProjectStrings(app)
  loadScene(app.world, JSON.parse(await platform.fs.readText(manifest.startScene)), {
    id: manifest.startScene,
  })
  await whenSceneReady(app.world, manifest.startScene)

  const session = new ProjectSession(app, {
    namespace: manifest.name,
    current: project,
    bundle: { hash: info.bundle, ms: 0 },
  })
  session.watching = Boolean(import.meta.hot)
  session.onChange((s) => {
    if (s.bundle) void mapFor(s.bundle.hash)
    if (s.error) {
      const { message, source } = s.error
      show(source && !message.includes(source) ? `${message}\n${source}` : message, true)
    } else show('')
  })
  const server = createProtocolServer(app, { frames: 'loop', platform, methods: session.methods() })
  session.onChange((s) => server.publish('project', s))
  connectToHub(info.hub, server, { name: `shard dev: ${manifest.name}` })

  // Hot reload: the dev server pushes new bundles and asset changes over Vite's socket.
  import.meta.hot?.on(
    'shard:project',
    (msg: {
      url?: string
      ms?: number
      procgen?: DevGenerators
      error?: Record<string, string>
    }) => {
      if (msg.error) {
        const e = msg.error
        session.buildFailed(
          Object.assign(
            new ShardError(e.code ?? 'project/bundle-failed', e.message ?? 'Build failed', {
              path: e.path,
              hint: e.hint,
            }),
            { source: e.source },
          ),
        )
        return
      }
      const url = msg.url!
      useGenerators(msg.procgen, platform.workers)
      void mapFor(url).then(() =>
        session.reload(() => import(/* @vite-ignore */ url), { hash: url, ms: msg.ms ?? 0 }),
      )
    },
  )
  import.meta.hot?.on('shard:assets', () => void assets.scan())

  Object.assign(globalThis, { shard: { app, session, assets } })
  show('')
  canvas.focus()
  // The start scene is loaded: the first frame from here on is the first usable one, and
  // `shard capture` can drive the page (0062).
  app.markUsable()
  installCapturePage(app)
  app.setRunner(animationFrameRunner())
  await app.run()
}

start().catch((err: unknown) => {
  show(err instanceof ShardError ? `${err.code}: ${err.message}` : String(err), true)
  console.error(err)
})
