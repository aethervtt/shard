/**
 * The page `shard dev` serves: loads the engine, fetches the project bundle, runs the project with
 * a canvas and DOM input, and dials the dev server's hub so tools (and hot reload) can reach it.
 */
import { assetServer } from '@shard/assets'
import { ShardError } from '@shard/core'
import { createDomInputSource, createWebPlatform } from '@shard/platform-web'
import {
  buildApp,
  inlineSourceMap,
  locateInBundle,
  type ManifestValue,
  ProjectSession,
  type SourceMap,
} from '@shard/project'
import { connectToHub, createProtocolServer } from '@shard/protocol'
import { animationFrameRunner, LogResource, type Plugin } from '@shard/runtime'
import { loadScene, whenSceneReady } from '@shard/scene'

interface DevInfo {
  manifest: ManifestValue
  bundle: string
  hub: string
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
  const info = (await (await fetch('/@shard/project.json')).json()) as DevInfo
  const { manifest } = info
  document.title = `${manifest.name} · shard dev`
  const platform = createWebPlatform({ baseUrl: `${location.origin}/@shard/files/` })

  await mapFor(info.bundle)
  const project = (await import(/* @vite-ignore */ info.bundle)).default as Plugin
  const app = buildApp({ manifest, project, canvas, inputSource: createDomInputSource(canvas) })
  await app.init()

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
    (msg: { url?: string; ms?: number; error?: Record<string, string> }) => {
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
      void mapFor(url).then(() =>
        session.reload(() => import(/* @vite-ignore */ url), { hash: url, ms: msg.ms ?? 0 }),
      )
    },
  )
  import.meta.hot?.on('shard:assets', () => void assets.scan())

  Object.assign(globalThis, { shard: { app, session, assets } })
  show('')
  canvas.focus()
  app.setRunner(animationFrameRunner())
  await app.run()
}

start().catch((err: unknown) => {
  show(err instanceof ShardError ? `${err.code}: ${err.message}` : String(err), true)
  console.error(err)
})
