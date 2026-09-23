import type { App } from './app'

export interface Plugin {
  /** Unique name, used for dependencies (`physics3d`, `core/time`). */
  readonly name: string
  readonly dependencies?: readonly string[]
  /** Registers resources, systems, and other plugins. Runs in dependency order. */
  build(app: App): void
  /** Optional async setup (e.g. loading WASM), awaited before Startup. */
  ready?(app: App): Promise<void> | void
}

export function definePlugin(plugin: Plugin): Plugin {
  return plugin
}
