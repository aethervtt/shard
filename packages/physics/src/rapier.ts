import type RAPIER from '@dimforge/rapier3d-compat'

// Rapier's module loader: no ECS, no renderer, so `@aethervtt/shard-physics/track` can use it in a
// worker (0053).

export type Rapier = typeof RAPIER

/**
 * Which Rapier build: `regular` (fastest, deterministic only on one build and platform) or
 * `deterministic` (the same 0.20.0 API, with results that don't depend on the machine).
 */
export type RapierVariant = 'regular' | 'deterministic'

export interface LoadRapierOptions {
  /** Load the deterministic build (default false). */
  deterministic?: boolean
}

const modules = new Map<string, Promise<Rapier>>()

/** One initialized module per key, however many callers ask for it. */
function cached(key: string, load: () => Promise<unknown>): Promise<Rapier> {
  let loading = modules.get(key)
  if (!loading) {
    loading = (async () => {
      const mod = await load()
      const R = ((mod as { default?: unknown }).default ?? mod) as Rapier
      await R.init()
      return R
    })()
    modules.set(key, loading)
  }
  return loading
}

/**
 * Loads and initializes Rapier's WASM for a dimension and variant, once per process. The variants
 * are separate modules, so a page can run both (the game on the regular build, a dice worker on
 * the deterministic one).
 */
export function loadRapier(dim: 2 | 3, options?: LoadRapierOptions): Promise<Rapier> {
  if (options?.deterministic) {
    return dim === 3
      ? loadDeterministic3d()
      : cached('2/deterministic', () => import('@dimforge/rapier2d-deterministic-compat'))
  }
  return dim === 3
    ? cached('3/regular', () => import('@dimforge/rapier3d-compat'))
    : cached('2/regular', () => import('@dimforge/rapier2d-compat'))
}

/**
 * The deterministic 3D build alone. Tracks load it through this, so a track bundle references no
 * other build.
 */
export function loadDeterministic3d(): Promise<Rapier> {
  return cached('3/deterministic', () => import('@dimforge/rapier3d-deterministic-compat'))
}
