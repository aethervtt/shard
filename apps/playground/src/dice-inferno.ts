// Dice entrances and screen effects (0065), shown with an inferno skin: on a natural 20 the d20
// doesn't roll, it falls as a burning meteor, strikes its spot and lands in flames, and the table
// catches fire around it; on a natural 1 it fizzles in a puff of smoke. The table draws the fire:
// the dice publish `fire` screen effects, the host forwards them, and the table's handler burns.
// All of it is host code: a family, two entrances, a material, particle effects, a handler.

import { type AssetRef, type Entity, quat, t, type World } from '@aethervtt/shard-core'
import {
  type DiceEntranceContext,
  defineDiceEntrance,
  defineDiceFamily,
  spawnDiceWindow,
} from '@aethervtt/shard-dice'
import { plane } from '@aethervtt/shard-mesh'
import {
  ParticleEffect,
  ParticleEffects,
  ParticleEmitterOverrides,
  ParticleSystem,
} from '@aethervtt/shard-particles'
import {
  Cameras,
  defineMaterial,
  InstanceData,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
  NotShadowCaster,
  NotShadowReceiver,
  onScreenEffect,
  PointLight,
} from '@aethervtt/shard-render'
import { FrameDemand, Time } from '@aethervtt/shard-runtime'
import { Texture, Textures } from '@aethervtt/shard-texture'
import { Transform } from '@aethervtt/shard-transform'

/** An sRGB hex color as linear RGBA. */
function hex(s: string): [number, number, number, number] {
  const c = (i: number) => {
    const v = Number.parseInt(s.slice(1 + i * 2, 3 + i * 2), 16) / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return [c(0), c(1), c(2), 1]
}

// --- the inferno family ---------------------------------------------------------------------------

/**
 * Basalt with lava in its cracks. `infernoHeat` (an entrance sets it) makes the whole die burn; a
 * natural 20 (`infernoTriumph`) sets its top face on fire from the moment it lands (resultTime).
 */
export const InfernoDice = defineDiceFamily('playground/InfernoDice', {
  animated: { fps: 30 },
  fields: {
    infernoLava: t.color({ default: hex('#ff4a12'), description: 'Lava in the cracks.' }),
    infernoFlame: t.color({ default: hex('#ffc86a'), description: 'The flames on top.' }),
    infernoGlow: t.f32({ default: 9000, unit: 'cd/m²', description: 'Light of the lava.' }),
    infernoHeat: t.f32({ min: 0, max: 1.5, description: 'How hot the die burns (0 cold).' }),
    infernoTriumph: t.f32({
      description: 'The value that bursts into flame on landing (0: none).',
    }),
  },
  surface: `
  let fl_t = globals.time;
  let fl_n = dice_fbm(local * 2.6 + vec3f(value * 0.37));
  let fl_crack = 1.0 - smoothstep(0.0, 0.07, abs(dice_fbm(local * 3.4 + vec3f(1.7, value, 3.1)) - 0.5));
  let fl_pulse = 0.75 + 0.25 * sin(fl_t * 2.3 + fl_n * 9.0);
  let fl_since = max(0.0, globals.time - look.result_time) * step(0.5, look.result);
  let fl_burn = step(0.5, F.infernoTriumph) * (1.0 - step(0.5, abs(value - F.infernoTriumph))) * look.result;
  let fl_heat = clamp(F.infernoHeat + fl_burn * (0.5 + 0.5 * smoothstep(0.0, 1.2, fl_since)), 0.0, 1.5);
  // Flames lick up the die: noise rising over it, strongest on faces turned up.
  let fl_up = clamp(normalize(in.world_normal).y, 0.0, 1.0);
  let fl_flame = dice_fbm(local * 5.0 - vec3f(0.0, fl_t * 1.6, 0.0));
  let fl_tongue = smoothstep(0.35, 0.85, fl_flame + fl_up * 0.3) * fl_heat;
  p.base_color = mix(vec3f(0.035, 0.03, 0.03), vec3f(0.08, 0.05, 0.04), fl_n);
  p.roughness = 0.62;
  p.metallic = 0.0;
  let fl_lava = F.infernoLava.rgb * (fl_crack * fl_pulse * (0.35 + fl_heat) + fl_tongue * 0.8);
  let fl_top = m.top * fl_burn * smoothstep(0.0, 0.6, fl_since) * (0.6 + 0.4 * fl_flame);
  p.emissive += (fl_lava + F.infernoFlame.rgb * fl_top) * F.infernoGlow * (1.0 - m.coverage * 0.7);`,
  description: 'Playground: basalt and lava; a natural 20 lands in flames (0065).',
})

// --- the meteor's strike ------------------------------------------------------------------------------

/** The shockwave where the meteor strikes: a hot ring racing out, gone in half a second. */
export const Shockwave = defineMaterial('playground/Shockwave', {
  extends: 'none',
  blend: 'additive',
  fields: {
    color: t.color({ default: hex('#ffb15a'), description: 'The ring.' }),
    glow: t.f32({ default: 7000, unit: 'cd/m²', description: 'Its light.' }),
    start: t.f32({ unit: 's', description: 'The shader clock at the strike.' }),
  },
  shader: 'playground::shockwave',
})

/** The scorch the table keeps where it burned: dark, ragged, fading with InstanceData.x. */
export const Scorch = defineMaterial('playground/Scorch', {
  extends: 'none',
  blend: 'premultiplied',
  fields: {
    char: t.color({ default: [0.004, 0.003, 0.002, 1], description: 'The burnt felt.' }),
  },
  shader: 'playground::scorch',
})

const noise2 = `
fn inf_hash(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453123);
}
fn inf_noise(p: vec2f) -> f32 {
  let i = floor(p);
  var f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(inf_hash(i), inf_hash(i + vec2f(1.0, 0.0)), f.x),
             mix(inf_hash(i + vec2f(0.0, 1.0)), inf_hash(i + vec2f(1.0, 1.0)), f.x), f.y);
}`

export const INFERNO_SHADERS: { path: string; source: string }[] = [
  {
    path: 'playground::shockwave',
    source: `
import shard::pbr::types::VertexOutput;
import shard::globals::globals;
import ${Shockwave.modulePath}::${Shockwave.varName};
${noise2}
override fn vertex_extra(position: vec3f, normal: vec3f, uv: vec2f) -> vec4f {
  return vec4f(position.x, -position.z, 0.0, 0.0);
}
override fn shade(in: VertexOutput) -> vec4f {
  let S = ${Shockwave.varName};
  let age = globals.time - S.start;
  if (age < 0.0 || age > 0.6) { return vec4f(0.0); }
  let k = age / 0.6;
  let r = length(in.extra.xy);
  let front = 0.12 + k * 0.85;
  let off = (r - front) / (0.05 + k * 0.06);
  let band = exp(-off * off) * (1.0 - k) * (1.0 - k);
  let ragged = 0.7 + 0.3 * inf_noise(vec2f(atan2(in.extra.y, in.extra.x) * 6.0, age * 9.0));
  return vec4f(S.color.rgb * S.glow * band * ragged, 1.0);
}`,
  },
]

export const SCORCH_SHADERS: { path: string; source: string }[] = [
  {
    path: 'playground::scorch',
    source: `
import shard::pbr::types::VertexOutput;
import shard::mesh::vertex_instance_data;
import ${Scorch.modulePath}::${Scorch.varName};
${noise2}
override fn vertex_extra(position: vec3f, normal: vec3f, uv: vec2f) -> vec4f {
  return vec4f(vertex_instance_data().x, 0.0, 0.0, 0.0);
}
override fn shade(in: VertexOutput) -> vec4f {
  let q = in.uv * 2.0 - 1.0;
  let d = length(q);
  let ragged = inf_noise(q * 4.0) * 0.35 + inf_noise(q * 11.0) * 0.15;
  let a = (1.0 - smoothstep(0.3 + ragged, 1.0, d)) * in.extra.x * 0.55;
  return vec4f(${Scorch.varName}.char.rgb * a, a);
}`,
  },
]

// --- particle effects --------------------------------------------------------------------------------

const sprites = new WeakMap<World, AssetRef<'Texture'>>()

/** A soft round sprite for the particles, made once per world (untextured billboards are squares). */
function spriteOf(world: World): { guid: string } {
  let ref = sprites.get(world)
  if (!ref) {
    const size = 64
    const data = new Uint8Array(size * size * 4)
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const d = Math.hypot(((x + 0.5) / size) * 2 - 1, ((y + 0.5) / size) * 2 - 1)
        const k = Math.max(0, 1 - d)
        const o = (y * size + x) * 4
        data[o] = data[o + 1] = data[o + 2] = 255
        data[o + 3] = Math.round(k * k * (3 - 2 * k) * 255)
      }
    }
    ref = world
      .resource(Textures)
      .add(
        Texture.create({ width: size, height: size, mips: [data] }),
        'playground:spark',
      ) as AssetRef<'Texture'>
    sprites.set(world, ref)
  }
  return { guid: ref.guid! }
}

const effects = new WeakMap<World, Map<string, AssetRef<'ParticleEffect'>>>()

/** A particle effect, made once per world. */
function effectOf(world: World, name: string, json: () => unknown): AssetRef<'ParticleEffect'> {
  let byName = effects.get(world)
  if (!byName) {
    byName = new Map()
    effects.set(world, byName)
  }
  let ref = byName.get(name)
  if (!ref) {
    ref = world
      .resource(ParticleEffects)
      .add(ParticleEffect.fromJson(json() as never)) as AssetRef<'ParticleEffect'>
    byName.set(name, ref)
  }
  return ref
}

const FIRE_GRADIENT = [
  [0, hex('#fff2c8'), 1],
  [0.25, hex('#ffb347'), 0.9],
  [0.6, hex('#e0431a'), 0.5],
  [1, hex('#2a0a04'), 0],
]

/** The meteor's trail: flame and sparks shed where it has been (world space). */
const trailEffect = (world: World) =>
  effectOf(world, 'trail', () => ({
    emitters: [
      {
        name: 'flame',
        capacity: 256,
        spawn: { rate: 220 },
        shape: { type: 'sphere', radius: 0.12 },
        init: {
          lifetime: [0.25, 0.55],
          speed: [0.1, 0.5],
          size: [0.1, 0.22],
          color: hex('#fff2c8'),
        },
        update: [
          { module: 'drag', coefficient: 2 },
          { module: 'color-over-life', gradient: FIRE_GRADIENT },
          {
            module: 'size-over-life',
            curve: [
              [0, 1],
              [1, 0.2],
            ],
          },
        ],
        render: { blend: 'additive', emissive: 24_000, texture: spriteOf(world) },
      },
    ],
  }))

/** The strike: sparks flung out, and a dark puff. */
const strikeEffect = (world: World) =>
  effectOf(world, 'strike', () => ({
    emitters: [
      {
        name: 'sparks',
        capacity: 64,
        spawn: { rate: 0, bursts: [{ time: 0, count: 48 }] },
        shape: { type: 'sphere', radius: 0.1 },
        init: { lifetime: [0.4, 0.9], speed: [2.5, 5], size: [0.025, 0.05], color: hex('#ffe4a8') },
        update: [
          { module: 'gravity', acceleration: [0, -6, 0] },
          { module: 'drag', coefficient: 1.2 },
          { module: 'color-over-life', gradient: FIRE_GRADIENT },
        ],
        render: {
          blend: 'additive',
          mode: 'stretched',
          stretch: 0.05,
          emissive: 40_000,
          texture: spriteOf(world),
        },
      },
    ],
  }))

/** A fizzle: a slow grey puff with a few dying embers. */
const smokeEffect = (world: World) =>
  effectOf(world, 'smoke', () => ({
    emitters: [
      {
        name: 'smoke',
        capacity: 48,
        spawn: { rate: 0, bursts: [{ time: 0, count: 28 }] },
        shape: { type: 'sphere', radius: 0.15 },
        init: { lifetime: [0.8, 1.4], speed: [0.2, 0.7], size: [0.15, 0.3], color: hex('#7a726c') },
        update: [
          { module: 'velocity-over-life', velocity: [0, 0.6, 0] },
          { module: 'drag', coefficient: 1.5 },
          {
            module: 'color-over-life',
            gradient: [
              [0, hex('#8a817a'), 0.6],
              [1, hex('#3a3633'), 0],
            ],
          },
          {
            module: 'size-over-life',
            curve: [
              [0, 0.6],
              [1, 2],
            ],
          },
        ],
        render: { blend: 'alpha', texture: spriteOf(world) },
      },
      {
        name: 'embers',
        capacity: 16,
        spawn: { rate: 0, bursts: [{ time: 0, count: 10 }] },
        shape: { type: 'sphere', radius: 0.1 },
        init: {
          lifetime: [0.3, 0.7],
          speed: [0.6, 1.4],
          size: [0.02, 0.04],
          color: hex('#ff8a3a'),
        },
        update: [
          { module: 'gravity', acceleration: [0, -3, 0] },
          { module: 'color-over-life', gradient: FIRE_GRADIENT },
        ],
        render: { blend: 'additive', emissive: 20_000, texture: spriteOf(world) },
      },
    ],
  }))

/** The table's fire: flames licking up from a patch of felt. */
const flamesEffect = (world: World) =>
  effectOf(world, 'flames', () => ({
    emitters: [
      {
        name: 'flames',
        capacity: 512,
        spawn: { rate: 260 },
        shape: { type: 'box', size: [1.6, 0.05, 1.6] },
        init: {
          lifetime: [0.35, 0.8],
          speed: [0.2, 0.6],
          size: [0.12, 0.3],
          color: hex('#fff2c8'),
        },
        update: [
          { module: 'velocity-over-life', velocity: [0, 1.4, 0] },
          { module: 'curl-noise', strength: 1.5, frequency: 1.4 },
          { module: 'color-over-life', gradient: FIRE_GRADIENT },
          {
            module: 'size-over-life',
            curve: [
              [0, 0.6],
              [0.3, 1],
              [1, 0.1],
            ],
          },
        ],
        render: { blend: 'additive', emissive: 16_000, texture: spriteOf(world) },
      },
    ],
  }))

// --- entrances ---------------------------------------------------------------------------------------

/** Per scene: whether it struck yet, and its spin axis. */
const scenes = new WeakMap<
  DiceEntranceContext,
  { struck: boolean; spin: [number, number, number] }
>()

const ease = (x: number) => {
  const k = Math.max(0, Math.min(1, x))
  return k * k * (3 - 2 * k)
}

/** The die's rotation `turns` of a spin away from its rest, so it lands exactly at rest. */
function spun(
  rest: readonly number[],
  axis: readonly [number, number, number],
  turns: number,
): [number, number, number, number] {
  const spin = quat.fromAxisAngle([0, 0, 0, 1], axis, turns * Math.PI * 2)
  return quat.multiply([0, 0, 0, 1], spin, rest as never) as [number, number, number, number]
}

/**
 * `meteor`: the die falls from above the page, burning and spinning, trailing flame; it strikes its
 * spot at 1.05 s (a flash, a shockwave, sparks), lands in flames, and sets the table on fire.
 */
export function defineInfernoEntrances(): void {
  defineDiceEntrance('meteor', {
    vertices: 64,
    durationMs: 2800,
    landAtMs: 1050,
    impact: 1,
    spawn(ctx) {
      const w = ctx.world
      const [x, y, z] = ctx.rest.position
      // A spin axis from the roll's seed: the same fall for every viewer.
      const ax = (ctx.seed & 1023) / 1023 - 0.5
      const az = ((ctx.seed >>> 10) & 1023) / 1023 - 0.5
      const n = Math.hypot(ax, 0.6, az)
      scenes.set(ctx, { struck: false, spin: [ax / n, 0.6 / n, az / n] })
      const trail = w.spawn(
        [
          ParticleSystem,
          { effect: trailEffect(w), seed: ctx.seed, backend: 'cpu', space: 'world' },
        ],
        [
          Transform,
          { translation: [x, y + 12 * ctx.scale, z], scale: [ctx.scale, ctx.scale, ctx.scale] },
        ],
      )
      const strike = w.spawn(
        [
          ParticleSystem,
          { effect: strikeEffect(w), seed: ctx.seed ^ 7, backend: 'cpu', playing: false },
        ],
        [Transform, { translation: [x, y, z], scale: [ctx.scale, ctx.scale, ctx.scale] }],
      )
      const ring = w
        .resource(Materials)
        .add(new MaterialAsset({ start: 1e9 }, Shockwave)) as AssetRef<'Material'>
      const wave = spawnDiceWindow(ctx, ring, {
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        turn: 0,
        lift: 0.3,
        at: ctx.rest.position,
      })
      ctx.material({ infernoHeat: 1.2 })
      return [trail, strike, wave]
    },
    update(ctx, s, [trail, strike, wave]) {
      const w = ctx.world
      const state = scenes.get(ctx)
      if (!state) return false
      const [x, y, z] = ctx.rest.position
      if (s < ctx.landAt && !ctx.skipped) {
        // Accelerating down a slant from high over the page's left, spinning to its rest.
        const k = s / ctx.landAt
        const fall = 1 - k * k
        const at: [number, number, number] = [
          x - 5 * ctx.scale * fall,
          y + 12 * ctx.scale * fall,
          z - 3 * ctx.scale * fall,
        ]
        ctx.show(true)
        ctx.pose(at, spun(ctx.rest.rotation, state.spin, 2.5 * fall))
        if (trail !== undefined) w.set(trail, Transform, { translation: at })
        return true
      }
      if (!state.struck) {
        state.struck = true
        if (trail !== undefined) w.add(trail, ParticleEmitterOverrides, { spawnScale: 0 })
        if (strike !== undefined) w.set(strike, ParticleSystem, { playing: true })
        const m = wave === undefined ? undefined : w.get(wave, MeshMaterial).material
        if (m)
          w.resource(Materials)
            .get(m)
            ?.set({ start: w.resource(Time).elapsed })
        ctx.cue('void-whump', 0.9)
      }
      // The die cools from the meteor's heat to its own flames; the table burns while it does.
      const after = s - ctx.landAt
      ctx.material({ infernoHeat: 1.2 * (1 - ease(after / 1.4)) })
      if (after < 1.5)
        ctx.effect({ kind: 'fire', radius: 170, ttlMs: 250, params: { intensity: 1 } })
      return true
    },
  })

  /** `fizzle`: a short drop, a sputter, a puff of smoke, and a small scorch. */
  defineDiceEntrance('fizzle', {
    vertices: 16,
    durationMs: 1800,
    landAtMs: 420,
    impact: 0.35,
    spawn(ctx) {
      const w = ctx.world
      scenes.set(ctx, { struck: false, spin: [0, 1, 0] })
      ctx.material({ infernoHeat: 0 })
      return [
        w.spawn(
          [
            ParticleSystem,
            { effect: smokeEffect(w), seed: ctx.seed, backend: 'cpu', playing: false },
          ],
          [
            Transform,
            {
              translation: ctx.rest.position,
              scale: [ctx.scale, ctx.scale, ctx.scale],
            },
          ],
        ),
      ]
    },
    update(ctx, s, [smoke]) {
      const w = ctx.world
      const state = scenes.get(ctx)
      if (!state) return false
      const [x, y, z] = ctx.rest.position
      if (s < ctx.landAt && !ctx.skipped) {
        const k = s / ctx.landAt
        const wobble = Math.sin(k * 14) * (1 - k) * 0.12
        ctx.show(true)
        ctx.pose(
          [x, y + 1.8 * ctx.scale * (1 - k * k), z],
          spun(ctx.rest.rotation, [1, 0, 0], wobble),
        )
        return true
      }
      if (!state.struck) {
        state.struck = true
        if (smoke !== undefined) w.set(smoke, ParticleSystem, { playing: true })
        ctx.cue('void-whump', 0.4)
      }
      if (s - ctx.landAt < 0.8)
        ctx.effect({ kind: 'fire', radius: 60, ttlMs: 250, params: { intensity: 0.2 } })
      return true
    },
  })
}

// --- the table burns ---------------------------------------------------------------------------------

/** Where a CSS pixel of the table's view falls on the table (y = 0), or null. */
function tablePoint(
  world: World,
  camera: Entity,
  sx: number,
  sy: number,
): [number, number, number] | null {
  const cam = world.resource(Cameras).get(camera)
  if (!cam || cam.displayWidth === 0) return null
  const x = (sx / (cam.displayWidth / cam.pixelRatio)) * 2 - 1
  const y = 1 - (sy / (cam.displayHeight / cam.pixelRatio)) * 2
  const m = cam.invViewProj
  const at = (z: number) => {
    const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!
    return [
      (m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / w,
      (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / w,
      (m[2]! * x + m[6]! * y + m[10]! * z + m[14]!) / w,
    ]
  }
  // Reversed depth: the near plane at 1; a point partway out for the ray.
  const a = at(1)
  const b = at(0.5)
  const dy = b[1]! - a[1]!
  if (Math.abs(dy) < 1e-9) return null
  const k = -a[1]! / dy
  if (k < 0) return null
  return [a[0]! + (b[0]! - a[0]!) * k, 0, a[2]! + (b[2]! - a[2]!) * k]
}

interface Burning {
  flames: Entity
  light: Entity
  scorch: Entity
  power: number
  started: number
  /** When it went out (NaN while it burns). */
  ended: number
}

const FIRE_DEMAND = 'playground/fire'

/**
 * Registers `fire` on the table: flames and a flickering light where a die asks, sized from the
 * effect's radius and intensity, and a scorch that stays a while. When the effect stops, the flames
 * die down over a second and the scorch fades over ten.
 */
export function burnTable(world: World, camera: Entity): void {
  const burning = new Map<number, Burning>()
  let quad: AssetRef<'Mesh'> | undefined
  let scorch: AssetRef<'Material'> | undefined
  onScreenEffect(world, 'fire', {
    start(w, e) {
      const at = tablePoint(w, camera, e.screen[0], e.screen[1])
      const edge = tablePoint(w, camera, e.screen[0] + e.radius, e.screen[1])
      if (!at || !edge) return []
      const r = Math.max(0.2, Math.hypot(edge[0] - at[0], edge[2] - at[2]))
      const power = Math.max(0.05, Number(e.params.intensity ?? 1))
      quad ??= w.resource(Meshes).add(plane({ size: 2 })) as AssetRef<'Mesh'>
      scorch ??= w.resource(Materials).add(new MaterialAsset({}, Scorch)) as AssetRef<'Material'>
      const now = w.resource(Time).elapsed
      const fire: Burning = {
        flames: w.spawn(
          [
            ParticleSystem,
            { effect: flamesEffect(w), seed: e.source, backend: 'cpu', space: 'world' },
          ],
          [ParticleEmitterOverrides, { spawnScale: power }],
          [Transform, { translation: at, scale: [r * 0.6, r * 0.6 * power, r * 0.6] }],
        ),
        light: w.spawn(
          [PointLight, { color: hex('#ff7a2a'), intensity: 0, range: r * 5, shadows: false }],
          [Transform, { translation: [at[0], 0.4 + r * 0.3, at[2]] }],
        ),
        scorch: w.spawn(
          [Mesh3d, { mesh: quad }],
          [MeshMaterial, { material: scorch }],
          [InstanceData, { x: 0, y: 0 }],
          NotShadowCaster,
          NotShadowReceiver,
          [Transform, { translation: [at[0], 0.004, at[2]], scale: [r * 0.9, 1, r * 0.9] }],
        ),
        power,
        started: now,
        ended: Number.NaN,
      }
      burning.set(e.source, fire)
      w.resource(FrameDemand).hold(FIRE_DEMAND)
      return []
    },
    update(w, e) {
      const fire = burning.get(e.source)
      if (fire) flicker(w, fire)
    },
    end(w, e) {
      const fire = burning.get(e.source)
      if (!fire) return
      fire.ended = w.resource(Time).elapsed
      w.set(fire.flames, ParticleEmitterOverrides, { spawnScale: 0 })
    },
  })
  fires.set(world, burning)
}

const fires = new WeakMap<World, Map<number, Burning>>()

function flicker(w: World, fire: Burning): void {
  const t = w.resource(Time).elapsed
  const grow = Math.min(1, (t - fire.started) / 0.4)
  const out = Number.isNaN(fire.ended) ? 1 : Math.max(0, 1 - (t - fire.ended) / 1)
  const f = 0.8 + 0.12 * Math.sin(t * 23) + 0.08 * Math.sin(t * 37 + 1.3)
  w.set(fire.light, PointLight, { intensity: 900 * fire.power * grow * out * f })
  const char = Number.isNaN(fire.ended) ? grow : Math.max(0, 1 - (t - fire.ended) / 10)
  w.set(fire.scorch, InstanceData, { x: Math.max(1e-3, char * Math.min(1, fire.power * 2)), y: 0 })
}

/** Each frame of the table: fires that went out die down, then go. Call it from the table's frame. */
export function tendFires(world: World): void {
  const burning = fires.get(world)
  if (!burning || burning.size === 0) return
  const t = world.resource(Time).elapsed
  for (const [source, fire] of burning) {
    if (Number.isNaN(fire.ended)) continue
    flicker(world, fire)
    if (t - fire.ended < 10) continue
    for (const e of [fire.flames, fire.light, fire.scorch]) if (world.isAlive(e)) world.despawn(e)
    burning.delete(source)
  }
  if (burning.size === 0) world.resource(FrameDemand).release(FIRE_DEMAND)
}
