import { ShardError } from '@shard/core'
import { box, capsule, cone, cube, cylinder, type Mesh, plane, sphere, torus } from '@shard/mesh'

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
