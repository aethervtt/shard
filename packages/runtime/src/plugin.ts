import type { App } from './app'

export interface Plugin {
  /** Unique name, used for dependencies (`physics3d`, `core/time`). */
  readonly name: string
  readonly dependencies?: readonly string[]
  /**
   * The modules (`import * as components from './components'`) or values whose definitions and
   * registrations this plugin needs at runtime. Referencing them keeps them in a tree-shaken bundle
   * (every package is `sideEffects: false`), so a scene that names a component finds it whenever the
   * plugin that provides it is installed.
   */
  readonly provides?: readonly object[]
  /** Registers resources, systems, and other plugins. Runs in dependency order. */
  build(app: App): void
  /** Optional async setup (e.g. loading WASM), awaited before Startup. */
  ready?(app: App): Promise<void> | void
}

export function definePlugin(plugin: Plugin): Plugin {
  return plugin
}
