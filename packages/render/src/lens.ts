import {
  defineComponent,
  defineResource,
  defineSystem,
  type Entity,
  type World,
} from '@aethervtt/shard-core'
import { FrameDemand, Time } from '@aethervtt/shard-runtime'
import { Camera3d } from './camera'

/** Fields `LensFields` holds at once. */
export const MAX_LENS_FIELDS = 4

/** A screen-space field that bends what's behind it (0063). */
export interface LensField {
  /** Center, in the target's CSS pixels. */
  screen: [number, number]
  /** In CSS pixels. */
  radius: number
  /** -1..1: above 0 magnifies the middle, below 0 pulls the surroundings in. 0 bends nothing. */
  strength: number
  /** Ms it has left: counts down each frame, and refreshing sets it again. At 0 it drops. */
  ttlMs: number
  /** What published it (a die), so it can clear its own. */
  source: Entity
}

export const LensFields = defineResource<{ fields: LensField[] }>('render/LensFields', {
  hostWritable: true,
  description:
    'Screen-space fields effects publish (at most 4): center and radius in CSS pixels, strength, ms to live, source entity. Views with Lens bend their own pixels inside them (lensPlugin).',
  init: () => ({ fields: [] }),
})

export const Lens = defineComponent(
  'render/Lens',
  {},
  {
    description:
      "Tag: this camera's view bends its own pixels inside the live LensFields, after the display stage. Pixels outside every field are left exactly as rendered.",
    requires: [Camera3d],
  },
)

/** Present when lensPlugin is installed; without it Lens cameras render unbent. */
export const LensPath = defineResource<{ installed: true }>('render/LensPath', {
  description: 'Present when lens fields (lensPlugin) are installed.',
})

/**
 * Publishes or refreshes `source`'s field: a field with the same source is replaced. Returns false
 * when `MAX_LENS_FIELDS` other sources hold fields already.
 */
export function publishLensField(world: World, field: LensField): boolean {
  const fields = world.initResource(LensFields).fields
  let i = 0
  while (i < fields.length && fields[i]!.source !== field.source) i++
  if (i === MAX_LENS_FIELDS) return false
  const f = fields[i]
  if (f) {
    f.screen[0] = field.screen[0]
    f.screen[1] = field.screen[1]
    f.radius = field.radius
    f.strength = field.strength
    f.ttlMs = field.ttlMs
  } else fields.push({ ...field, screen: [field.screen[0], field.screen[1]] })
  world.touchResource(LensFields)
  return true
}

/** Drops `source`'s fields, or every field. Publishers call it on dismissal and teardown. */
export function clearLensFields(world: World, source?: Entity): void {
  const value = world.tryResource(LensFields)
  if (!value || value.fields.length === 0) return
  if (source === undefined) value.fields.length = 0
  else value.fields = value.fields.filter((f) => f.source !== source)
  world.touchResource(LensFields)
}

const NO_OFFSET = [0, 0] as const

/**
 * Copies `from`'s fields into `to` (another app on the device, 0052), for the host to call each
 * frame they're live. Copies, not shares: each app counts its fields down on its own. `offset` is
 * where `to`'s target sits in `from`'s CSS pixels (a table canvas below a page-wide dice canvas's
 * top bar, say); it's subtracted from each field's center.
 */
export function forwardLensFields(
  from: World,
  to: World,
  offset: readonly [number, number] = NO_OFFSET,
): void {
  const source = from.tryResource(LensFields)?.fields ?? []
  const out = to.initResource(LensFields).fields
  const n = Math.min(source.length, MAX_LENS_FIELDS)
  for (let i = 0; i < n; i++) {
    const s = source[i]!
    const d = out[i]
    if (d) {
      d.radius = s.radius
      d.strength = s.strength
      d.ttlMs = s.ttlMs
      d.source = s.source
    } else out.push({ ...s, screen: [0, 0] })
    const f = out[i]!
    f.screen[0] = s.screen[0] - offset[0]
    f.screen[1] = s.screen[1] - offset[1]
  }
  if (out.length === 0 && n === 0) return
  out.length = n
  to.touchResource(LensFields)
}

/** The frame demand live fields hold, so they expire on time and the app idles after (0052). */
export const LENS_DEMAND = 'render/lens-fields'

export const expireLensFields = defineSystem({
  name: 'render/expire-lens-fields',
  description:
    'Counts LensFields down by the frame time and drops expired ones; holds frames while any live.',
  run: (_, world) => {
    const fields = world.tryResource(LensFields)?.fields
    let n = 0
    if (fields && fields.length > 0) {
      const ms = world.resource(Time).delta * 1000
      for (let i = 0; i < fields.length; i++) {
        const f = fields[i]!
        f.ttlMs -= ms
        // Bounded, whatever a host patched in.
        if (f.ttlMs > 0 && n < MAX_LENS_FIELDS) fields[n++] = f
      }
      fields.length = n
    }
    world.tryResource(FrameDemand)?.set(LENS_DEMAND, n > 0)
  },
})
