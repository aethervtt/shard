import { existsSync } from 'node:fs'
import { ShardError } from '@aethervtt/shard-core'
import { parseGltf } from '@aethervtt/shard-gltf'
import { SURFACE_PRESETS, type SurfacePreset } from '@aethervtt/shard-physics'
import {
  type GltfJson,
  generateVehicle,
  MANEUVERS,
  type Maneuver,
  modelNodesFromGltf,
  templateFromPrefab,
  testTemplate,
  VEHICLE_CLASSES,
  type VehicleClass,
  type VehicleTestReport,
} from '@aethervtt/shard-vehicle'
import { type CommandContext, withProject } from './commands'
import { EXIT } from './output'

const USAGE = `Usage: shard vehicle gen <model> [--class ${VEHICLE_CLASSES.join('|')}] [--facing -z|+z] [--out file] [--force] | shard vehicle test <prefab> [--surface asphalt] [--maneuvers ${MANEUVERS.join(',')}]`

async function gen(ctx: CommandContext, model: string): Promise<number> {
  const cls = (typeof ctx.flags.class === 'string' ? ctx.flags.class : 'sedan') as VehicleClass
  if (!(VEHICLE_CLASSES as readonly string[]).includes(cls)) {
    throw new ShardError('cli/usage', `Unknown class "${cls}"`, {
      hint: `Classes: ${VEHICLE_CLASSES.join(', ')}.`,
    })
  }
  const facing = ctx.flags.facing === '+z' ? '+z' : '-z'
  const out =
    typeof ctx.flags.out === 'string'
      ? ctx.flags.out
      : `prefabs/${model.slice(model.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '')}.prefab.json`
  return withProject(ctx, { loadStartScene: false }, async (p) => {
    if (existsSync(`${p.root}/${out}`) && ctx.flags.force !== true) {
      throw new ShardError('cli/exists', `${out} exists`, {
        hint: 'Pass --force to overwrite it, or --out another file.',
      })
    }
    const bytes = await p.platform.fs.readBytes(model)
    const { json } = parseGltf(new Uint8Array(bytes))
    const prefab = generateVehicle(modelNodesFromGltf(json as GltfJson), {
      model,
      class: cls,
      facing,
    })
    await p.platform.fs.writeText(out, `${JSON.stringify(prefab, null, 2)}\n`)
    const children = (
      prefab.root as {
        children: { name: string; components: Record<string, Record<string, unknown>> }[]
      }
    ).children
    const wheels = children.filter((c) => c.components['vehicle/VehicleWheel'])
    const summary = wheels.map((w) => {
      const v = w.components['vehicle/VehicleWheel']!
      return { node: v.visualName, axle: v.axle, side: v.side, radius: v.radius, width: v.width }
    })
    const lines = [`Wrote ${out}: a ${cls} with ${wheels.length} wheels from ${model}.`]
    for (const w of summary)
      lines.push(`  ${w.node}: axle ${w.axle} ${w.side}, radius ${w.radius} m, width ${w.width} m`)
    lines.push(`Tune it against: shard vehicle test ${out}`)
    ctx.out.result({ out, class: cls, wheels: summary }, lines.join('\n'))
    return EXIT.ok
  })
}

function describeReport(file: string, r: VehicleTestReport): string {
  const lines = [`${file} on ${r.surface}:`]
  const f = (v: number | undefined, d = 1) =>
    v === undefined || Number.isNaN(v) ? '—' : v.toFixed(d)
  if (r.accel)
    lines.push(
      `  0–60 ${f(r.accel.to60)} s, 0–100 ${f(r.accel.to100)} s, quarter mile ${f(r.accel.quarterMile)} s`,
    )
  if (r.top)
    lines.push(
      `  top ${f(r.top.reached, 0)} km/h (limiter per gear: ${r.top.perGear.map((v) => v.toFixed(0)).join(', ')})`,
    )
  if (r.brake)
    lines.push(
      `  ${f(r.brake.from, 0)}–0 km/h in ${f(r.brake.distance)} m${r.brake.abs ? ' (ABS)' : ''}`,
    )
  if (r.skidpad) lines.push(`  skidpad ${f(r.skidpad.lateralG, 2)} g`)
  if (r.step)
    lines.push(
      `  step steer at ${f(r.step.speed, 0)} km/h: peak drift ${f(r.step.peakDrift)}°${r.step.spun ? ', spun' : ''}${r.step.rolled ? ', ROLLED' : ''}${r.step.lifted ? ', lifted two wheels' : ''}`,
    )
  if (r.climb) lines.push(`  climbs ${r.climb.grade}%`)
  if (r.understeer)
    lines.push(`  understeer K ${r.understeer.k.toExponential(2)} s²/m (VehicleAssists.understeer)`)
  return lines.join('\n')
}

async function test(ctx: CommandContext, file: string): Promise<number> {
  const surface = (
    typeof ctx.flags.surface === 'string' ? ctx.flags.surface : 'asphalt'
  ) as SurfacePreset
  if (!(surface in SURFACE_PRESETS)) {
    throw new ShardError('physics/unknown-surface', `No surface preset "${surface}"`, {
      hint: `Presets: ${Object.keys(SURFACE_PRESETS).join(', ')}.`,
    })
  }
  const asked =
    typeof ctx.flags.maneuvers === 'string'
      ? ctx.flags.maneuvers.split(',').map((m) => m.trim())
      : []
  for (const m of asked) {
    if (!(MANEUVERS as readonly string[]).includes(m))
      throw new ShardError('cli/usage', `Unknown maneuver "${m}"`, {
        hint: `One of ${MANEUVERS.join(', ')}.`,
      })
  }
  return withProject(ctx, { loadStartScene: false }, async (p) => {
    const json = JSON.parse(await p.platform.fs.readText(file))
    const template = templateFromPrefab(json)
    const report = await testTemplate(template, {
      surface,
      maneuvers: asked.length > 0 ? (asked as Maneuver[]) : MANEUVERS,
    })
    ctx.out.result(report, describeReport(file, report))
    return report.step?.rolled ? EXIT.failed : EXIT.ok
  })
}

/** `shard vehicle gen|test` (0118). */
export async function vehicle(ctx: CommandContext): Promise<number> {
  const [verb, file] = ctx.args
  if (!file || (verb !== 'gen' && verb !== 'test')) throw new ShardError('cli/usage', USAGE)
  return verb === 'gen' ? gen(ctx, file) : test(ctx, file)
}
