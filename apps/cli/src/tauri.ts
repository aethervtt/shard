/**
 * The developer's Tauri app around an export (0111): scaffolded once by `--init`, checked (never
 * edited) by every export after that.
 */
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ManifestValue } from '@aethervtt/shard-project'
import { encodePng } from '@aethervtt/shard-verify/node'

const here = dirname(fileURLToPath(import.meta.url))
const posix = (path: string) => path.split(sep).join('/')

export interface TauriApp {
  /** The project folder. */
  root: string
  manifest: ManifestValue
  /** The export's folder (`dist/tauri`): `page/` and `data/` inside. */
  out: string
  /** The app's `src-tauri` folder. */
  appDir: string
  /** The sidecar's name when the app bundles the game server: `coin-rush-server`. */
  server?: string
}

/** The engine version this CLI ships with: the plugin crate's version to match. */
export function engineVersion(): string {
  return JSON.parse(readFileSync(join(here, '../package.json'), 'utf8')).version as string
}

/** The repository this CLI runs from, when it does (examples depend on the plugin by path). */
function shardRepo(): string | undefined {
  const repo = resolve(here, '../../..')
  return existsSync(join(repo, 'crates/tauri-plugin-shard/Cargo.toml')) ? repo : undefined
}

function pluginDependency(appDir: string): string {
  const repo = shardRepo()
  if (repo) {
    const path = posix(relative(appDir, join(repo, 'crates/tauri-plugin-shard')))
    return `{ path = ${JSON.stringify(path)} }`
  }
  return `{ git = "https://github.com/aethervtt/shard", tag = "v${engineVersion()}" }`
}

/** A plain square icon, so the app builds before it has its own (`tauri icon` makes real ones). */
function placeholderIcon(): Uint8Array {
  const size = 256
  const rgba = new Uint8Array(size * size * 4)
  for (let i = 0; i < size * size; i++) rgba.set([38, 52, 82, 255], i * 4)
  return encodePng(rgba, size, size)
}

/**
 * The same icon as a one-image `.ico` holding the PNG: what tauri-build needs on Windows for the
 * executable's resources (256 × 256 is written as 0 in the directory entry).
 */
function icoOf(png: Uint8Array): Uint8Array {
  const out = new Uint8Array(6 + 16 + png.length)
  const view = new DataView(out.buffer)
  view.setUint16(2, 1, true) // an icon
  view.setUint16(4, 1, true) // one image
  view.setUint16(6 + 4, 1, true) // color planes
  view.setUint16(6 + 6, 32, true) // bits per pixel
  view.setUint32(6 + 8, png.length, true)
  view.setUint32(6 + 12, 6 + 16, true)
  out.set(png, 6 + 16)
  return out
}

/**
 * Writes `src-tauri/` when it doesn't exist: Cargo.toml, the app with the Shard plugin, its
 * config pointing at the export, a capability, a placeholder icon. Returns what it wrote; an
 * existing folder is left alone (an empty list).
 */
export async function scaffoldTauri(app: TauriApp): Promise<string[]> {
  if (existsSync(app.appDir)) return []
  const { manifest } = app
  const title = manifest.export?.app?.title || manifest.name
  const crate = manifest.name.replace(/-/g, '_')
  const page = posix(relative(app.appDir, join(app.out, 'page')))
  const data = posix(relative(app.appDir, join(app.out, 'data')))
  const files: Record<string, string | Uint8Array> = {
    'Cargo.toml': `[package]
name = "${manifest.name}-desktop"
version = "${manifest.version}"
edition = "2024"
publish = false

[lib]
name = "${crate}_desktop_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-shard = ${pluginDependency(app.appDir)}
# generate_context!() writes code that uses them.
serde = { version = "1", features = ["derive"] }
serde_json = "1"

# A workspace of its own, so the app builds inside a monorepo that has another one.
[workspace]
`,
    'build.rs': 'fn main() {\n    tauri_build::build()\n}\n',
    'src/main.rs': `// No console window beside the game on Windows, in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    ${crate}_desktop_lib::run()
}
`,
    'src/lib.rs': `// The game: its page, its data (shard://) and saves through tauri-plugin-shard (Shard 0111).
// This file is yours: add commands and plugins here.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shard::init())
        .run(tauri::generate_context!())
        .expect("error while running ${title.replace(/"/g, '\\"')}");
}
`,
    'tauri.conf.json': `${JSON.stringify(
      {
        $schema: 'https://schema.tauri.app/config/2',
        productName: title,
        version: manifest.version,
        identifier: manifest.export?.app?.id || `com.example.${manifest.name}`,
        build: { frontendDist: page },
        app: {
          windows: [
            {
              label: 'main',
              title,
              width: manifest.window.width,
              height: manifest.window.height,
            },
          ],
          security: { csp: null },
        },
        bundle: {
          active: true,
          targets: 'all',
          icon: ['icons/icon.png', 'icons/icon.ico'],
          resources: { [`${data}/`]: 'game/' },
          ...(app.server ? { externalBin: [`binaries/${app.server}`] } : {}),
        },
        ...(app.server ? { plugins: { shard: { server: app.server } } } : {}),
      },
      null,
      2,
    )}\n`,
    'capabilities/default.json': `${JSON.stringify(
      {
        $schema: '../gen/schemas/desktop-schema.json',
        identifier: 'default',
        description: 'The game window: Tauri core and the Shard plugin.',
        windows: ['main'],
        permissions: ['core:default', 'shard:default'],
      },
      null,
      2,
    )}\n`,
    'icons/icon.png': placeholderIcon(),
    'icons/icon.ico': icoOf(placeholderIcon()),
    '.gitignore': '/target\n/gen/schemas\n/binaries\n',
  }
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(app.appDir, path)), { recursive: true })
    await writeFile(join(app.appDir, path), content)
  }
  return Object.keys(files)
}

/**
 * What doesn't line up between the app and the export (`export/tauri-mismatch` warnings): the page
 * and data folders, the plugin and its version, the sidecar. Reads, never writes.
 */
export async function checkTauri(app: TauriApp): Promise<string[]> {
  const problems: string[] = []
  const warn = (what: string) => problems.push(`export/tauri-mismatch: ${what}`)
  const confPath = join(app.appDir, 'tauri.conf.json')
  if (!existsSync(confPath)) {
    warn(`no ${posix(relative(app.root, confPath))}: run with --init, or set export.tauri.app`)
    return problems
  }
  let conf: {
    build?: { frontendDist?: string }
    bundle?: { resources?: string[] | Record<string, string>; externalBin?: string[] }
    plugins?: { shard?: { server?: string } }
  }
  try {
    conf = JSON.parse(await readFile(confPath, 'utf8'))
  } catch {
    warn('tauri.conf.json is not plain JSON, so it was not checked')
    return problems
  }
  const same = (a: string, b: string) => resolve(app.appDir, a) === resolve(b)
  const page = join(app.out, 'page')
  const data = join(app.out, 'data')
  if (!conf.build?.frontendDist || !same(conf.build.frontendDist, page)) {
    warn(`build.frontendDist should be "${posix(relative(app.appDir, page))}"`)
  }
  const resources = conf.bundle?.resources
  const mapped =
    resources && !Array.isArray(resources)
      ? Object.entries(resources).some(([from, to]) => same(from, data) && /^game\/?$/.test(to))
      : false
  if (!mapped) {
    warn(`bundle.resources should map "${posix(relative(app.appDir, data))}/" to "game/"`)
  }
  const cargo = await readFile(join(app.appDir, 'Cargo.toml'), 'utf8').catch(() => '')
  const dependency = /^tauri-plugin-shard\s*=\s*(.+)$/m.exec(cargo)?.[1]
  if (!dependency) warn('Cargo.toml has no tauri-plugin-shard dependency')
  else {
    const version = /version\s*=\s*"([^"]+)"|^"([^"]+)"/.exec(dependency)
    const tag = /tag\s*=\s*"v?([^"]+)"/.exec(dependency)?.[1]
    const wanted = engineVersion()
    const pinned = version?.[1] ?? version?.[2] ?? tag
    if (pinned && pinned.replace(/^[=^~]/, '') !== wanted && !shardRepo()) {
      warn(`tauri-plugin-shard is ${pinned}; this engine is ${wanted}`)
    }
  }
  const sources = await readdir(join(app.appDir, 'src')).catch(() => [] as string[])
  let registered = false
  for (const f of sources.filter((f) => f.endsWith('.rs'))) {
    if ((await readFile(join(app.appDir, 'src', f), 'utf8')).includes('tauri_plugin_shard::init')) {
      registered = true
    }
  }
  if (!registered) warn('no .plugin(tauri_plugin_shard::init()) in src/')
  if (app.server) {
    if (!conf.bundle?.externalBin?.includes(`binaries/${app.server}`)) {
      warn(`bundle.externalBin should list "binaries/${app.server}"`)
    }
    if (conf.plugins?.shard?.server !== app.server) {
      warn(`plugins.shard.server should be "${app.server}"`)
    }
  }
  return problems
}
