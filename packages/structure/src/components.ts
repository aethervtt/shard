import { defineComponent, defineResource, defineTag, t } from '@aethervtt/shard-core'

// Walls, openings and floors (0055), in world units (metres by convention). A host converts its
// own coordinates with one fixed visual scale; game distance ("5 ft per square") never places
// anything.

export const WALL_SHAPES = ['straight', 'arc', 'bezier'] as const

export const Wall = defineComponent(
  'structure/Wall',
  {
    a: t.vec2({ description: 'Start of the centreline, (x, z) in world units.' }),
    b: t.vec2({ description: 'End of the centreline, (x, z) in world units.' }),
    height: t.f32({ default: 3, min: 0, unit: 'm', description: 'Height above elevation.' }),
    thickness: t.f32({ default: 0.2, min: 0, unit: 'm', description: 'Full thickness.' }),
    elevation: t.f32({ unit: 'm', description: 'Where the wall stands (y).' }),
    material: t.handle('Material', { description: 'Surface material. Empty uses a plain grey.' }),
    shape: t.enum(WALL_SHAPES, {
      description: 'straight; arc (bowed by bow); bezier (a cubic through c0 and c1).',
    }),
    bow: t.f32({
      unit: 'm',
      description:
        'Arc: how far the midpoint bows off the line from a to b; positive bows to the left of a → b. More than half the chord is a major arc.',
    }),
    c0: t.vec2({ description: 'Bézier: the first control point, (x, z).' }),
    c1: t.vec2({ description: 'Bézier: the second control point, (x, z).' }),
  },
  {
    description:
      'A wall: straight, an arc or a Bézier (0066). Structure compile draws it into chunked, per-material meshes; the entity itself draws nothing.',
  },
)

export const OPENING_KINDS = ['door', 'window'] as const
export const HINGES = ['start', 'end'] as const
export const SWINGS = ['left', 'right'] as const
export const DOOR_STATES = ['closed', 'open', 'locked'] as const
export const CHANNELS = ['normal', 'none'] as const

export const Opening = defineComponent(
  'structure/Opening',
  {
    wall: t.entity({ description: 'The host wall entity.' }),
    kind: t.enum(OPENING_KINDS, {
      description: 'A door (with a leaf that swings) or a window (with glass).',
    }),
    offset: t.f32({
      min: 0,
      unit: 'm',
      description: "Distance from the wall's start to the opening.",
    }),
    width: t.f32({ default: 1, min: 0, unit: 'm', description: 'Width along the wall.' }),
    height: t.f32({ default: 2.1, min: 0, unit: 'm', description: 'Height of the hole.' }),
    sill: t.f32({
      min: 0,
      unit: 'm',
      description: "Height of the hole's bottom above the wall's base.",
    }),
    frameWidth: t.f32({
      default: 0.08,
      min: 0,
      unit: 'm',
      description: 'Width of the frame around the hole.',
    }),
    frameDepth: t.f32({
      default: 0.04,
      min: 0,
      unit: 'm',
      description: 'How far the frame stands out from each face of the wall.',
    }),
    frameMaterial: t.handle('Material', {
      description: 'Frame and door leaf material. Empty uses the built-in wood (structure:frame).',
    }),
    hinge: t.enum(HINGES, { description: 'Doors: which end of the opening the leaf hangs from.' }),
    swing: t.enum(SWINGS, { description: 'Doors: which side of the wall the leaf opens toward.' }),
    state: t.enum(DOOR_STATES, {
      description: 'Doors: a change swings the leaf and rebuilds no geometry.',
    }),
    sight: t.enum(CHANNELS, {
      description: 'Whether it blocks sight when closed (planarBarriers).',
    }),
    movement: t.enum(CHANNELS, {
      description: 'Whether it blocks movement when closed (planarBarriers).',
    }),
  },
  { description: 'A door or window cut into a wall.' },
)

export const Floor = defineComponent(
  'structure/Floor',
  {
    points: t.list(t.vec2, {
      description:
        'Outline, (x, z) in world units: a simple polygon of 3 to 256 points, either winding.',
    }),
    elevation: t.f32({ unit: 'm', description: 'Height of the floor (y).' }),
    material: t.handle('Material', { description: 'Surface material. Empty uses a plain grey.' }),
  },
  { description: 'A flat floor polygon, triangulated once per edit and clipped into chunks.' },
)

export const StructureChunk = defineComponent(
  'structure/Chunk',
  {
    x: t.i32({ readonly: true, description: 'Chunk column (x / chunkSize).' }),
    z: t.i32({ readonly: true, description: 'Chunk row (z / chunkSize).' }),
  },
  {
    description: "One chunk's geometry in one material, rebuilt by structure compile.",
    serialize: false,
    save: false,
  },
)

export const DoorLeaf = defineComponent(
  'structure/DoorLeaf',
  {
    opening: t.entity({ readonly: true, description: 'The door this leaf belongs to.' }),
    angle: t.f32({ readonly: true, description: 'How far open, 0 (closed) to 1 (open).' }),
  },
  {
    description:
      'A door leaf (or a window pane) that structure spawns for an opening. Picks resolve through `opening`.',
    serialize: false,
    save: false,
  },
)

/** Glass in a window: a pane that structure spawns and keeps. */
export const WindowPane = defineTag('structure/WindowPane', { serialize: false, save: false })

export interface StructureSettingsValue {
  /** Chunk edge, world units. Changing it rebuilds every chunk. */
  chunkSize: number
  /** How long a door takes to swing, ms. */
  doorSwingMs: number
  /** Doors snap open and closed instead of swinging. */
  reducedMotion: boolean
  /**
   * How far a curved wall's chords may stray from the curve, metres (0066). planarBarriers must
   * use the same value, so a server blocks what's drawn. Changing it rebuilds every chunk.
   */
  curveTolerance: number
}

export const StructureSettings = defineResource<StructureSettingsValue>('structure/Settings', {
  description:
    'Chunk size, door swing time, reduced motion and curve tolerance. Write with patchResource.',
  init: () => ({ chunkSize: 8, doorSwingMs: 250, reducedMotion: false, curveTolerance: 0.01 }),
  hostWritable: true,
})
