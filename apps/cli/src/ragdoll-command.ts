import { existsSync } from 'node:fs'
import {
  type AnimationClipAsset,
  AnimationClips,
  type BakeRetarget,
  type FlatSkeleton,
  flatRest,
  flatSkeleton,
  JointMaps,
} from '@aethervtt/shard-animation'
import type { AssetServer } from '@aethervtt/shard-assets'
import { type AssetRef, type JsonObject, ShardError, type World } from '@aethervtt/shard-core'
import type { Mesh } from '@aethervtt/shard-mesh'
import {
  bindRagdoll,
  checkRagdoll,
  extractClips,
  generateRagdoll,
  parseRagdoll,
} from '@aethervtt/shard-ragdoll'
import { Meshes, type SkinAsset, Skins } from '@aethervtt/shard-render'
import { SceneAssets, type SceneEntity } from '@aethervtt/shard-scene'
import { type CommandContext, withProject } from './commands'
import { EXIT } from './output'

const USAGE =
  'Usage: shard ragdoll gen <model> [--bodies humanoid|all] [--mass 70] [--out file] [--clips] [--retarget <skin> --map <jointmap>] [--force] | shard ragdoll check <asset> [--impulses 100] [--seed 1]'

interface Model {
  skin: SkinAsset
  skeleton: FlatSkeleton
  rest: Float32Array
  meshes: Mesh[]
}

/** A model's skin (as a flat skeleton, ancestors from its scene) and its skinned meshes. */
async function loadModel(assets: AssetServer, world: World, model: string): Promise<Model> {
  const info = assets.info(model)
  const subs = info.subAssets ?? []
  for (const s of subs) await assets.load(s.path)
  const skinSub = subs.find((s) => s.type === 'Skin')
  if (!skinSub) throw new ShardError('ragdoll/skeleton-mismatch', `${model} has no skin`)
  const skin = world.resource(Skins).get(assets.resolve<'Skin'>(skinSub.path)!)!
  // Non-joint ancestors (an Armature node) from the model's scene.
  const trs = new Map<string, { translation: number[]; rotation: number[]; scale: number[] }>()
  const sceneSub = subs.find((s) => s.type === 'Scene')
  const scene = sceneSub
    ? world.resource(SceneAssets).get(assets.resolve<'Scene'>(sceneSub.path)!)
    : undefined
  const walk = (list: SceneEntity[], prefix: string) => {
    for (const e of list) {
      const path = prefix ? `${prefix}/${e.name}` : e.name
      const t = e.components?.['core/Transform'] as Record<string, number[]> | undefined
      trs.set(path, {
        translation: t?.translation ?? [0, 0, 0],
        rotation: t?.rotation ?? [0, 0, 0, 1],
        scale: t?.scale ?? [1, 1, 1],
      })
      if (e.children) walk(e.children, path)
    }
  }
  if (scene) walk(scene.entities, '')
  const skeleton = flatSkeleton(skin, (path) => trs.get(path))
  const meshes: Mesh[] = []
  for (const s of subs) {
    if (s.type !== 'Mesh') continue
    const m = world.resource(Meshes).get(assets.resolve<'Mesh'>(s.path)!)
    if (m?.joints && m.weights && m.joints.length > 0) meshes.push(m)
  }
  return { skin, skeleton, rest: flatRest(skin), meshes }
}

/** Every animation clip in the project by its name (and its path). Cold. */
async function projectClips(assets: AssetServer, world: World, names: string[]) {
  const out = new Map<string, AnimationClipAsset>()
  const want = new Set(names)
  for (const entry of assets.all('AnimationClip')) {
    const short = entry.path.slice(entry.path.lastIndexOf('/') + 1)
    const file = entry.path
      .split('#')[0]!
      .replace(/^.*\//, '')
      .replace(/\.[^.]+$/, '')
    const hit = [entry.path, short, file].find((n) => want.has(n))
    if (!hit) continue
    await assets.load(entry.path)
    const clip = world.resource(AnimationClips).get(assets.resolve<'AnimationClip'>(entry.path)!)
    if (clip) out.set(hit, clip)
  }
  return out
}

function namesIn(json: JsonObject): string[] {
  const names: string[] = []
  for (const r of Object.values((json.rests ?? {}) as Record<string, JsonObject>)) {
    names.push(r.pose as string, r.getUp as string)
  }
  for (const r of Object.values((json.clips ?? {}) as Record<string, JsonObject | string>)) {
    if (typeof r === 'string') names.push(r)
    else names.push(...(Array.isArray(r.clip) ? (r.clip as string[]) : [r.clip as string]))
  }
  return names.filter(Boolean)
}

async function gen(ctx: CommandContext, model: string): Promise<number> {
  const out =
    typeof ctx.flags.out === 'string' ? ctx.flags.out : model.replace(/\.[^./]+$/, '.ragdoll.json')
  return withProject(ctx, { loadStartScene: false }, async (p) => {
    const world = p.app.world
    const m = await loadModel(p.assets, world, model)
    const bodies = ctx.flags.bodies === 'all' ? 'all' : 'humanoid'
    const mass = ctx.flags.mass === undefined ? 70 : Number(ctx.flags.mass)
    const json = generateRagdoll(m, { bodies, mass, skeleton: model })
    // Keep what was hand-edited beside the bodies: profiles, rests, clip roles, reactions.
    const existing = existsSync(`${p.root}/${out}`) && ctx.flags.force !== true
    if (existing) {
      const old = JSON.parse(await p.platform.fs.readText(out)) as JsonObject
      for (const k of ['profiles', 'rests', 'clips', 'reactions']) if (old[k]) json[k] = old[k]
    }
    let missing: string[] = []
    if (ctx.flags.clips === true) {
      const clips = await projectClips(p.assets, world, namesIn(json))
      let retarget: BakeRetarget | undefined
      if (typeof ctx.flags.retarget === 'string') {
        await p.assets.load(ctx.flags.retarget)
        const skin = world.resource(Skins).get(p.assets.resolve<'Skin'>(ctx.flags.retarget)!)!
        let map: BakeRetarget['map']
        if (typeof ctx.flags.map === 'string') {
          await p.assets.load(ctx.flags.map)
          map = world
            .resource(JointMaps)
            .get(p.assets.resolve<'JointMap'>(ctx.flags.map) as AssetRef<'JointMap'>)
        }
        retarget = { skin, ...(map ? { map } : {}), mode: 'rotation-and-root' }
      }
      missing = extractClips(json, { ...m, world, clips, ...(retarget ? { retarget } : {}) })
    }
    parseRagdoll(json) // the result must load
    await p.platform.fs.writeText(out, `${JSON.stringify(json, null, 2)}\n`)
    const n = Object.keys(json.bodies as object).length
    const lines = [
      `Wrote ${out}: ${n} bodies from ${model}${existing ? ' (kept its rests, roles, profiles)' : ''}.`,
    ]
    for (const name of missing) lines.push(`  warning: no clip "${name}" in the project`)
    ctx.out.result({ out, bodies: n, missing }, lines.join('\n'))
    return EXIT.ok
  })
}

async function check(ctx: CommandContext, file: string): Promise<number> {
  const trials = ctx.flags.impulses === undefined ? 100 : Number(ctx.flags.impulses)
  const seed = ctx.flags.seed === undefined ? 1 : Number(ctx.flags.seed)
  return withProject(ctx, { loadStartScene: false }, async (p) => {
    const json = JSON.parse(await p.platform.fs.readText(file)) as JsonObject
    const asset = parseRagdoll(json)
    const model = json.skeleton as string
    if (!model) throw new ShardError('ragdoll/skeleton-mismatch', `${file} names no skeleton model`)
    const m = await loadModel(p.assets, p.app.world, model)
    const result = await checkRagdoll(bindRagdoll(asset, m.skeleton, m.rest), { trials, seed })
    ctx.out.result(
      result,
      `${file}: ${trials} random hits (50–500 N·s): ${result.nan} NaN, ${result.below} joints under the ground, worst ${result.worstPastLimitDeg}° past a limit${result.worstJoint ? ` (${result.worstJoint})` : ''}. ${result.ok ? 'OK' : 'FAILED'}`,
    )
    return result.ok ? EXIT.ok : EXIT.failed
  })
}

/** `shard ragdoll gen|check` (0117). */
export async function ragdoll(ctx: CommandContext): Promise<number> {
  const [verb, file] = ctx.args
  if (!file || (verb !== 'gen' && verb !== 'check')) throw new ShardError('cli/usage', USAGE)
  return verb === 'gen' ? gen(ctx, file) : check(ctx, file)
}
