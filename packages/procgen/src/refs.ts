import { defineAssetResolver } from '@aethervtt/shard-assets'
import { defineProceduralSource } from '@aethervtt/shard-scene'
import { findGenerator, parseProceduralRef } from './generator'
import { procgen, setRefParser } from './runtime'

const GENERATOR_NAME = /^[a-z][a-z0-9-]*\/[A-Za-z][A-Za-z0-9]*$/

function label(spec: string): string {
  const hash = spec.indexOf('#')
  return hash === -1 ? '' : spec.slice(hash + 1)
}

export const refParser = setRefParser((spec) => parseProceduralRef(spec))

/**
 * `procedural:<generator>?params&seed=N` in scenes and prefabs: an output of a project or engine
 * generator. Equal canonical params (and seed) are one asset.
 */
export const generatorSource = defineProceduralSource({
  handles: (name) => name.includes('/'),
  check(spec, path) {
    const request = parseProceduralRef(spec, path)
    const sub = label(spec)
    return { type: sub === '' ? findGenerator(request.generator)!.outputType : 'Mesh' }
  },
  resolve(world, spec) {
    const entry = procgen(world).entryFor(parseProceduralRef(spec), label(spec))
    return { guid: entry.guid, path: entry.path, type: entry.type }
  },
})

/**
 * The catalog knows generators by name (`star-explorer/Rock`, a `Generator` asset) and outputs by
 * `procedural:` path, without anything imported.
 */
export const generatorResolver = defineAssetResolver((server, ref) => {
  if (ref.startsWith('procedural:')) {
    const spec = ref.slice('procedural:'.length)
    const name = spec.split(/[?#]/)[0]!
    if (!findGenerator(name)) return undefined
    try {
      return procgen(server.world).entryFor(parseProceduralRef(spec), label(spec))
    } catch {
      return undefined
    }
  }
  const name = ref.startsWith('generator:') ? ref.slice('generator:'.length) : ref
  if (!GENERATOR_NAME.test(name) || !findGenerator(name)) return undefined
  return server.virtual(`generator:${name}`, name, 'Generator', () => ({ generator: name }))
})
