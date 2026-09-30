import { type ResolvedAsset, ShardError, type World } from '@aethervtt/shard-core'
import {
  bevelBox,
  box,
  capsule,
  cone,
  cube,
  cylinder,
  type Mesh,
  plane,
  sphere,
  torus,
} from '@aethervtt/shard-mesh'

type Factory = (params: Record<string, number>) => Mesh

/** Procedural mesh sources, by name, with the parameters each accepts. */
export const PROCEDURAL_MESHES: Record<string, { params: readonly string[]; create: Factory }> = {
  box: { params: ['x', 'y', 'z'], create: (p) => box(p) },
  cube: { params: ['size'], create: (p) => cube(p) },
  sphere: { params: ['radius', 'segments', 'rings'], create: (p) => sphere(p) },
  plane: { params: ['size', 'subdivisions'], create: (p) => plane(p) },
  cylinder: { params: ['radius', 'radiusTop', 'height', 'segments'], create: (p) => cylinder(p) },
  cone: { params: ['radius', 'height', 'segments'], create: (p) => cone(p) },
  capsule: { params: ['radius', 'height', 'segments', 'rings'], create: (p) => capsule(p) },
  torus: {
    params: ['radius', 'tube', 'radialSegments', 'tubularSegments'],
    create: (p) => torus(p),
  },
  // The stand-in for a mesh or model that failed to load (0061).
  'missing-box': {
    params: [],
    create: () => {
      const mesh = bevelBox()
      mesh.missing = true
      return mesh
    },
  },
}

export interface ProceduralRef {
  source: string
  params: Record<string, number>
  /** Canonical key: equal refs share one mesh (and instance together). */
  key: string
}

/** Parses `procedural:box?x=4&y=1` (or a name + params object). Throws with a hint on bad input. */
export function parseProcedural(
  source: string,
  params: Record<string, unknown> = {},
  path?: string,
): ProceduralRef {
  let name = source
  const all: Record<string, unknown> = { ...params }
  const q = source.indexOf('?')
  if (q !== -1) {
    name = source.slice(0, q)
    for (const pair of source.slice(q + 1).split('&')) {
      if (!pair) continue
      const [k, v] = pair.split('=')
      all[k!] = v === undefined ? undefined : Number(v)
    }
  }
  const def = PROCEDURAL_MESHES[name]
  if (!def) {
    throw new ShardError('scene/unknown-procedural', `Unknown procedural mesh "${name}"`, {
      path,
      hint: `Use one of: ${Object.keys(PROCEDURAL_MESHES).join(', ')}.`,
    })
  }
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(all)) {
    if (!def.params.includes(k)) {
      throw new ShardError('scene/unknown-procedural-param', `"${name}" has no parameter "${k}"`, {
        path,
        hint: `Parameters: ${def.params.join(', ')}.`,
      })
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new ShardError(
        'scene/invalid-procedural-param',
        `"${name}" parameter "${k}" must be a number`,
        { path },
      )
    }
    out[k] = v
  }
  const key = `procedural:${name}?${Object.keys(out)
    .sort()
    .map((k) => `${k}=${out[k]}`)
    .join('&')}`
  return { source: name, params: out, key }
}

// --- other sources -------------------------------------------------------------------------------

/**
 * A kind of `procedural:` ref beyond the built-in meshes, e.g. project generators
 * (`procedural:star-explorer/Rock?seed=3`). `spec` is everything after `procedural:`.
 */
export interface ProceduralSource {
  /** Whether this source handles refs named `name` (the part before `?`). */
  handles(name: string): boolean
  /** Checks a ref without making anything; throws a ShardError (with `path`) if it's invalid. */
  check(spec: string, path?: string): { type: string }
  /** The asset for a ref, registered with the world's asset server (it may still be loading). */
  resolve(world: World, spec: string): ResolvedAsset
}

const sources: ProceduralSource[] = []

/** Adds a source of `procedural:` refs. Once per source. */
export function defineProceduralSource(source: ProceduralSource): ProceduralSource {
  if (!sources.includes(source)) sources.push(source)
  return source
}

export function allProceduralSources(): readonly ProceduralSource[] {
  return sources
}

/** The source for a `procedural:` spec, if it isn't a built-in mesh. */
export function proceduralSourceFor(spec: string): ProceduralSource | undefined {
  const q = spec.indexOf('?')
  const name = q === -1 ? spec : spec.slice(0, q)
  if (PROCEDURAL_MESHES[name]) return undefined
  return sources.find((s) => s.handles(name))
}
