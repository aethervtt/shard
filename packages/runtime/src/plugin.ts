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
  /**
   * Releases what `build` and `ready` created that outlives the app: GPU objects, surfaces, DOM
   * listeners, observers, workers. `app.dispose()` calls it in reverse build order, after the
   * runner stopped (0052).
   */
  dispose?(app: App): Promise<void> | void
  /**
   * Waits for work the plugin started that is still in flight (GPU commands submitted but not
   * done). `app.dispose()` awaits it on every plugin before any plugin's `dispose`, so nothing is
   * released while still in use: render's dispose runs last, after others freed their buffers.
   */
  beforeDispose?(app: App): Promise<void> | void
}

export function definePlugin(plugin: Plugin): Plugin {
  return plugin
}
