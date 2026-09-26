import { findComponent, isPlainObject, type JsonValue, pointer, ShardError } from '@shard/core'
import { encodeMesh, Mesh, type MeshData } from '@shard/mesh'
import { PREFAB_VERSION } from '@shard/scene'
import { buildMips, type MipChain, writeKtx2 } from '@shard/texture'
import type { Fragment, FragmentEntity, Generator, MeshResult, TextureData } from './generator'

/** One asset a generator run made: the main output ('') or a sub-asset (`LOD1`). */
export interface GenOutputAsset {
  label: string
  type: string
  bytes?: Uint8Array
  json?: JsonValue
  info?: Record<string, JsonValue>
}

function mismatch(gen: Generator, message: string, path?: string, details?: ShardError[]) {
  return new ShardError('procgen/output-mismatch', `${gen.name}: ${message}`, {
    path,
    hint:
      gen.output === 'mesh'
        ? 'Return ctx.mesh.finish(mesh) or mesh data ({ positions, normals?, indices? }).'
        : gen.output === 'texture'
          ? 'Return { width, height, mips: [rgba8 bytes] } (Float32Array levels for usage "hdr").'
          : gen.output === 'entities'
            ? 'Return an entity { name, components, children } or a list of them; components by name with JSON values.'
            : `Return a value of ${gen.outputType}.`,
    details,
  })
}

function round(n: number): number {
  return Math.round(n * 1e4) / 1e4
}

function meshInfo(mesh: Mesh): Record<string, JsonValue> {
  const b = mesh.bounds
  return {
    vertices: mesh.vertexCount,
    triangles: Math.floor(mesh.drawCount / 3),
    bounds: {
      min: [round(b[0]!), round(b[1]!), round(b[2]!)],
      max: [round(b[3]!), round(b[4]!), round(b[5]!)],
    },
  }
}

function checkedMesh(gen: Generator, data: MeshData, what: string): Mesh {
  try {
    return Mesh.create(data)
  } catch (err) {
    throw mismatch(gen, `${what}: ${(err as Error).message}`)
  }
}

function encodeMeshOutput(gen: Generator, value: unknown): GenOutputAsset[] {
  const result = value as Partial<MeshResult> & Partial<MeshData>
  const main = result?.kind === 'mesh' ? result.mesh : (result as MeshData | undefined)
  if (!main || !(main.positions instanceof Float32Array)) {
    throw mismatch(gen, `run returned ${describe(value)}, not a mesh`)
  }
  const mesh = checkedMesh(gen, main, 'the mesh')
  const lods = result?.kind === 'mesh' ? (result.lods ?? []) : []
  const info = meshInfo(mesh)
  const out: GenOutputAsset[] = [{ label: '', type: 'Mesh', bytes: encodeMesh(mesh), info }]
  const lodInfo: JsonValue[] = []
  lods.forEach((lod, i) => {
    const m = checkedMesh(gen, lod, `LOD ${i + 1}`)
    const li = meshInfo(m)
    lodInfo.push(li.triangles!)
    out.push({ label: `LOD${i + 1}`, type: 'Mesh', bytes: encodeMesh(m), info: li })
  })
  if (lodInfo.length) info.lods = lodInfo
  return out
}

function encodeTextureOutput(gen: Generator, value: unknown): GenOutputAsset[] {
  const tex = value as Partial<TextureData> | undefined
  const w = tex?.width
  const h = tex?.height
  if (!tex || !Number.isInteger(w) || !Number.isInteger(h) || !Array.isArray(tex.mips)) {
    throw mismatch(gen, `run returned ${describe(value)}, not a texture`)
  }
  const usage = tex.usage ?? 'color'
  const hdr = usage === 'hdr'
  const level0 = tex.mips[0]
  const expected = w! * h! * 4
  if (!level0 || level0.length !== expected || hdr !== level0 instanceof Float32Array) {
    throw mismatch(
      gen,
      `level 0 must be ${expected} ${hdr ? 'floats (Float32Array)' : 'bytes (Uint8Array)'} for ${w}×${h} RGBA`,
    )
  }
  const chain: MipChain =
    tex.mipmaps && tex.mips.length === 1
      ? buildMips(
          { width: w!, height: h!, kind: hdr ? 'f32' : 'u8', data: level0 },
          { usage, mipmaps: true, maxSize: 16384, flipY: false, premultiplyAlpha: false },
        )
      : { width: w!, height: h!, levels: tex.mips }
  return [
    {
      label: '',
      type: 'Texture',
      bytes: writeKtx2(chain, usage),
      info: { width: w!, height: h!, usage, mips: chain.levels.length },
    },
  ]
}

function encodeDataOutput(gen: Generator, value: unknown): GenOutputAsset[] {
  if (gen.dataType) {
    const json = toJson(value)
    const errors = gen.dataType.validate(json)
    if (errors.length > 0) {
      throw mismatch(
        gen,
        `the value isn't a ${gen.outputType}: ${errors[0]!.message}`,
        errors[0]!.path,
        errors,
      )
    }
    return [
      {
        label: '',
        type: gen.outputType,
        json: gen.dataType.serialize(gen.dataType.deserialize(json)),
      },
    ]
  }
  if (value === undefined) throw mismatch(gen, 'run returned undefined')
  return [{ label: '', type: 'Data', json: toJson(value) }]
}

/** Plain JSON of a value: refs lose their `type`, typed arrays become arrays. */
export function toJson(value: unknown): JsonValue {
  if (value === null || typeof value !== 'object') {
    return (typeof value === 'number' && !Number.isFinite(value) ? null : value) as JsonValue
  }
  if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>)
  if (Array.isArray(value)) return value.map(toJson)
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj)
  const isRef =
    typeof obj.type === 'string' &&
    (typeof obj.guid === 'string' || typeof obj.path === 'string') &&
    keys.every((k) => k === 'type' || k === 'guid' || k === 'path')
  const out: Record<string, JsonValue> = {}
  for (const k of keys) {
    if (isRef && k === 'type') continue
    if (obj[k] !== undefined) out[k] = toJson(obj[k])
  }
  return out
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  if (ArrayBuffer.isView(value)) return `a ${value.constructor.name}`
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`
}

function encodeEntities(gen: Generator, value: unknown, check: boolean): GenOutputAsset[] {
  const fragment = value as Fragment
  const root: FragmentEntity = Array.isArray(fragment)
    ? { name: gen.name.slice(gen.name.indexOf('/') + 1), children: fragment }
    : fragment
  if (!isPlainObject(root)) throw mismatch(gen, `run returned ${describe(value)}, not entities`)
  const errors: ShardError[] = []
  const counts: Record<string, number> = {}
  let entities = 0
  const walk = (e: FragmentEntity, at: string, isRoot: boolean): JsonValue => {
    const out: Record<string, JsonValue> = {}
    if (typeof e.name !== 'string' || e.name === '' || e.name.includes('/')) {
      errors.push(
        new ShardError(
          'procgen/output-mismatch',
          'Every entity needs a "name" (non-empty, no "/")',
          {
            path: `${at}/name`,
          },
        ),
      )
    }
    out.name = e.name
    if (!isRoot) entities++
    if (e.components !== undefined) {
      const comps: Record<string, JsonValue> = {}
      for (const [name, raw] of Object.entries(e.components)) {
        const where = pointer(`${at}/components`, name)
        if (!check) {
          comps[name] = toJson(raw)
          counts[name] = (counts[name] ?? 0) + 1
          continue
        }
        let def: ReturnType<typeof findComponent> | undefined
        try {
          def = findComponent(name)
        } catch {
          def = undefined
        }
        if (!def?.serializable) {
          errors.push(
            new ShardError('procgen/output-mismatch', `Unknown component "${name}"`, {
              path: where,
              hint: 'Components are by registered name, e.g. "core/Transform" (see .agents/components.md).',
            }),
          )
          continue
        }
        const json = toJson(raw)
        for (const err of def.validate(json)) {
          errors.push(
            new ShardError('procgen/output-mismatch', err.message, {
              path: `${where}${err.path ?? ''}`,
              hint: err.hint,
            }),
          )
        }
        comps[name] = json
        counts[name] = (counts[name] ?? 0) + 1
      }
      out.components = comps
    }
    if (e.children !== undefined) {
      if (!Array.isArray(e.children)) {
        errors.push(
          new ShardError('procgen/output-mismatch', '"children" must be a list', {
            path: `${at}/children`,
          }),
        )
      } else {
        const names = new Set<string>()
        out.children = e.children.map((c, i) => {
          if (names.has(c?.name)) {
            errors.push(
              new ShardError('procgen/output-mismatch', `Two children are named "${c.name}"`, {
                path: `${at}/children/${i}/name`,
                hint: 'Sibling names must be unique: they form the paths overrides and references use.',
              }),
            )
          }
          names.add(c?.name)
          return walk(c, `${at}/children/${i}`, false)
        })
      }
    }
    return out
  }
  const json = walk(root, '/root', true)
  if (errors.length > 0) {
    throw mismatch(gen, `${errors[0]!.path}: ${errors[0]!.message}`, errors[0]!.path, errors)
  }
  return [
    {
      label: '',
      type: 'Prefab',
      json: { version: PREFAB_VERSION, root: json },
      info: {
        entities,
        components: Object.fromEntries(
          Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)),
        ),
      },
    },
  ]
}

/**
 * Turns what `run` returned into artifacts, checking it's the generator's output type. With
 * `checkComponents: false`, entities' components aren't checked against their schemas (a worker
 * whose bundle may predate the current schemas; the caller checks with `checkFragment`).
 */
export function encodeOutput(
  gen: Generator,
  value: unknown,
  options: { checkComponents?: boolean } = {},
): GenOutputAsset[] {
  if (gen.output === 'mesh') return encodeMeshOutput(gen, value)
  if (gen.output === 'texture') return encodeTextureOutput(gen, value)
  if (gen.output === 'entities') return encodeEntities(gen, value, options.checkComponents ?? true)
  return encodeDataOutput(gen, value)
}

/** Checks an `entities` artifact's components against this thread's schemas; throws like `run`. */
export function checkFragment(gen: Generator, asset: GenOutputAsset): void {
  const root = (asset.json as { root?: FragmentEntity } | undefined)?.root
  encodeEntities(gen, root, true)
}
