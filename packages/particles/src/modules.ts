import type { ShardError } from '@aethervtt/shard-core'
import {
  curve,
  evalCurve,
  wgslFloat as f,
  gradient,
  invalid,
  type Rgba,
  rand,
  scalar,
  wgslCurve,
  wgslGradient,
} from './values'

/** A module parameter: its form, default, and what it means (for the published schema). */
export interface ParamDef {
  kind: 'number' | 'scalar' | 'vec3' | 'curve' | 'gradient' | 'enum'
  default?: unknown
  values?: readonly string[]
  description: string
}

/** A particle's state as the CPU backend holds it (one particle, reused). */
export interface CpuParticle {
  pos: Float32Array
  vel: Float32Array
  age: number
  life: number
  rot: number
  rotSpeed: number
  seed: number
}

export interface ModuleDef {
  name: string
  description: string
  params: Record<string, ParamDef>
  /** WGSL run once at spawn, after the init values (can set rot_speed). */
  init?(p: Record<string, unknown>): string
  /** WGSL run every step for a live particle: pos, vel, age, life, rot, rot_speed, seed, dt. */
  update?(p: Record<string, unknown>, id: string): string
  /** Helper functions the update or render code calls (curves, gradients). */
  functions?(p: Record<string, unknown>, id: string): string
  /** WGSL in the vertex stage: t (life fraction), color, size. */
  render?(p: Record<string, unknown>, id: string): string
  /** The CPU backend's version of `init` and `update`. */
  cpuInit?(p: Record<string, unknown>, s: CpuParticle): void
  cpu?(p: Record<string, unknown>, s: CpuParticle, dt: number, time: number): void
  /** Needs the view's depth buffer (collision). */
  depth?: boolean
}

const vec3 = (v: unknown) => `vec3f(${(v as number[]).map(f).join(', ')})`

export const MODULES: Record<string, ModuleDef> = {
  gravity: {
    name: 'gravity',
    description: 'Constant acceleration.',
    params: {
      acceleration: { kind: 'vec3', default: [0, -9.81, 0], description: 'm/s², world axes.' },
    },
    update: (p) => `vel += ${vec3(p.acceleration)} * dt;`,
    cpu: (p, s, dt) => {
      const a = p.acceleration as number[]
      for (let k = 0; k < 3; k++) s.vel[k]! += a[k]! * dt
    },
  },
  drag: {
    name: 'drag',
    description: 'Slows particles exponentially: velocity × e^(−coefficient · t).',
    params: { coefficient: { kind: 'number', default: 1, description: 'Per second.' } },
    update: (p) => `vel *= exp(${f(-(p.coefficient as number))} * dt);`,
    cpu: (p, s, dt) => {
      const k = Math.exp(-(p.coefficient as number) * dt)
      for (let i = 0; i < 3; i++) s.vel[i]! *= k
    },
  },
  'velocity-over-life': {
    name: 'velocity-over-life',
    description:
      'An extra velocity, scaled by a curve over life (wind that dies down, a late lift).',
    params: {
      velocity: { kind: 'vec3', default: [0, 1, 0], description: 'm/s.' },
      curve: {
        kind: 'curve',
        default: [
          [0, 1],
          [1, 1],
        ],
        description: 'Multiplier over life.',
      },
    },
    functions: (p, id) => wgslCurve(`${id}_curve`, p.curve as [number, number][]),
    update: (p, id) => `pos += ${vec3(p.velocity)} * ${id}_curve(age / life) * dt;`,
    cpu: (p, s, dt) => {
      const m = evalCurve(p.curve as [number, number][], s.age / s.life)
      const v = p.velocity as number[]
      for (let k = 0; k < 3; k++) s.pos[k]! += v[k]! * m * dt
    },
  },
  'curl-noise': {
    name: 'curl-noise',
    description: 'Swirling, divergence-free turbulence (smoke, exhaust).',
    params: {
      strength: { kind: 'number', default: 1, description: 'm/s² at full swirl.' },
      frequency: { kind: 'number', default: 1, description: 'Swirls per meter.' },
      speed: {
        kind: 'number',
        default: 0.5,
        description: 'How fast the field changes, per second.',
      },
    },
    update: (p) => {
      const s = f(p.strength as number)
      const q = f(p.frequency as number)
      const w = f(p.speed as number)
      // The curl of (sin(qy + wt), sin(qz + wt), sin(qx + wt)), plus a rotated octave.
      return `{
    let ph = time * ${w};
    let a = -vec3f(cos(pos.z * ${q} + ph), cos(pos.x * ${q} + ph), cos(pos.y * ${q} + ph));
    let b = -vec3f(cos((pos.x + pos.y) * ${q} * 1.7 - ph), cos((pos.y + pos.z) * ${q} * 1.7 - ph), cos((pos.z + pos.x) * ${q} * 1.7 - ph)).zxy;
    vel += (a + 0.5 * b) * ${s} * dt;
  }`
    },
    cpu: (p, s, dt, time) => {
      const q = p.frequency as number
      const ph = time * (p.speed as number)
      const [x, y, z] = [s.pos[0]!, s.pos[1]!, s.pos[2]!]
      const a = [-Math.cos(z * q + ph), -Math.cos(x * q + ph), -Math.cos(y * q + ph)]
      const b0 = [
        -Math.cos((x + y) * q * 1.7 - ph),
        -Math.cos((y + z) * q * 1.7 - ph),
        -Math.cos((z + x) * q * 1.7 - ph),
      ]
      const b = [b0[2]!, b0[0]!, b0[1]!]
      for (let k = 0; k < 3; k++) s.vel[k]! += (a[k]! + 0.5 * b[k]!) * (p.strength as number) * dt
    },
  },
  attractor: {
    name: 'attractor',
    description:
      'Pulls particles toward a point (negative strength pushes away), fading to zero at radius.',
    params: {
      position: {
        kind: 'vec3',
        default: [0, 0, 0],
        description: "In the effect's space (local to the emitter for local systems).",
      },
      strength: { kind: 'number', default: 5, description: 'm/s² at the center.' },
      radius: { kind: 'number', default: 5, description: 'm.' },
    },
    update: (p) => `{
    let d = ${vec3(p.position)} - pos;
    let len = max(length(d), 1e-4);
    vel += d / len * ${f(p.strength as number)} * clamp(1.0 - len / ${f(p.radius as number)}, 0.0, 1.0) * dt;
  }`,
    cpu: (p, s, dt) => {
      const c = p.position as number[]
      const d = [c[0]! - s.pos[0]!, c[1]! - s.pos[1]!, c[2]! - s.pos[2]!]
      const len = Math.max(Math.sqrt(d[0]! * d[0]! + d[1]! * d[1]! + d[2]! * d[2]!), 1e-4)
      const k =
        ((p.strength as number) * Math.min(1, Math.max(0, 1 - len / (p.radius as number))) * dt) /
        len
      for (let i = 0; i < 3; i++) s.vel[i]! += d[i]! * k
    },
  },
  rotation: {
    name: 'rotation',
    description: 'Spins billboards: a speed per particle, picked from a range.',
    params: { speed: { kind: 'scalar', default: [-90, 90], description: 'Degrees per second.' } },
    init: (p) => {
      const [a, b] = p.speed as [number, number]
      return `rot_speed = radians(mix(${f(a)}, ${f(b)}, rand(seed, 20u)));`
    },
    update: () => 'rot += rot_speed * dt;',
    cpuInit: (p, s) => {
      const [a, b] = p.speed as [number, number]
      s.rotSpeed = ((a + (b - a) * rand(s.seed, 20)) * Math.PI) / 180
    },
    cpu: (_, s, dt) => {
      s.rot += s.rotSpeed * dt
    },
  },
  'color-over-life': {
    name: 'color-over-life',
    description: 'Multiplies the color (and alpha) by a gradient over life.',
    params: { gradient: { kind: 'gradient', description: '[[t, color, alpha?], …].' } },
    functions: (p, id) => wgslGradient(`${id}_gradient`, p.gradient as [number, Rgba][]),
    render: (_, id) => `color *= ${id}_gradient(t);`,
  },
  'size-over-life': {
    name: 'size-over-life',
    description: 'Multiplies the size by a curve over life.',
    params: { curve: { kind: 'curve', description: '[[t, multiplier], …].' } },
    functions: (p, id) => wgslCurve(`${id}_curve`, p.curve as [number, number][]),
    render: (_, id) => `size *= ${id}_curve(t);`,
  },
  collision: {
    name: 'collision',
    description:
      "Collides with what the camera sees (its depth buffer): bounce or die. GPU only; off screen, particles pass through. The CPU backend doesn't collide.",
    params: {
      mode: {
        kind: 'enum',
        values: ['bounce', 'die'],
        default: 'bounce',
        description: 'What a hit does.',
      },
      restitution: {
        kind: 'number',
        default: 0.5,
        description: 'Speed kept along the normal (0..1).',
      },
      friction: {
        kind: 'number',
        default: 0.2,
        description: 'Speed lost along the surface (0..1).',
      },
      thickness: {
        kind: 'number',
        default: 0.5,
        description: 'm: surfaces this far behind the depth buffer still count.',
      },
    },
    depth: true,
    update: (p) => `{
    let hit = depth_collision(pos, vel, ${f(p.thickness as number)});
    if (hit.w > 0.0) {
      ${
        p.mode === 'die'
          ? 'age = life;'
          : `let n = hit.xyz;
      let vn = dot(vel, n);
      if (vn < 0.0) {
        let vt = vel - n * vn;
        vel = vt * ${f(1 - (p.friction as number))} - n * vn * ${f(p.restitution as number)};
      }`
      }
    }
  }`,
  },
}

/** Validates a module entry in place (filling defaults); pushes errors with pointers. */
export function validateModule(
  json: unknown,
  path: string,
  errors: ShardError[],
): Record<string, unknown> | undefined {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    errors.push(invalid(path, 'Expected a module: { "module": "<name>", …parameters }'))
    return undefined
  }
  const entry = json as Record<string, unknown>
  const def = MODULES[entry.module as string]
  if (!def) {
    errors.push(
      invalid(
        `${path}/module`,
        `Unknown module ${JSON.stringify(entry.module)}`,
        `Modules: ${Object.keys(MODULES).join(', ')}.`,
      ),
    )
    return undefined
  }
  const out: Record<string, unknown> = { module: def.name }
  for (const key of Object.keys(entry)) {
    if (key !== 'module' && !def.params[key]) {
      errors.push(
        invalid(
          `${path}/${key}`,
          `${def.name} has no parameter "${key}"`,
          `Parameters: ${Object.keys(def.params).join(', ')}.`,
        ),
      )
    }
  }
  for (const [key, param] of Object.entries(def.params)) {
    const v = entry[key]
    const at = `${path}/${key}`
    if (v === undefined && param.default === undefined) {
      errors.push(invalid(at, `${def.name} needs "${key}"`, param.description))
      continue
    }
    const value = v ?? param.default
    switch (param.kind) {
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value))
          errors.push(invalid(at, 'Expected a number'))
        out[key] = value
        break
      case 'scalar':
        out[key] = scalar(value, at, errors, 0)
        break
      case 'vec3':
        if (
          !Array.isArray(value) ||
          value.length !== 3 ||
          !value.every((n) => typeof n === 'number')
        ) {
          errors.push(invalid(at, 'Expected [x, y, z]'))
        }
        out[key] = value
        break
      case 'curve':
        out[key] = curve(value, at, errors)
        break
      case 'gradient':
        out[key] = gradient(value, at, errors)
        break
      case 'enum':
        if (!param.values!.includes(value as string)) {
          errors.push(invalid(at, `Expected one of: ${param.values!.join(', ')}`))
        }
        out[key] = value
        break
    }
  }
  return out
}

/** JSON Schema of a module entry, from its parameter definitions. */
export function moduleJsonSchema(def: ModuleDef): Record<string, unknown> {
  const range = { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 }
  const forms: Record<ParamDef['kind'], unknown> = {
    number: { type: 'number' },
    scalar: { anyOf: [{ type: 'number' }, range] },
    vec3: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
    curve: { anyOf: [{ type: 'number' }, { type: 'array', items: range }] },
    gradient: { type: 'array', items: { type: 'array' } },
    enum: {},
  }
  const properties: Record<string, unknown> = { module: { const: def.name } }
  for (const [key, p] of Object.entries(def.params)) {
    properties[key] = {
      ...(p.kind === 'enum' ? { enum: p.values } : (forms[p.kind] as object)),
      description: p.description,
      ...(p.default !== undefined ? { default: p.default } : {}),
    }
  }
  return {
    type: 'object',
    description: def.description,
    properties,
    required: [
      'module',
      ...Object.entries(def.params)
        .filter(([, p]) => p.default === undefined)
        .map(([k]) => k),
    ],
    additionalProperties: false,
  }
}
