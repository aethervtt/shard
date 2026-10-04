import { defineComponent, defineResource, defineTag, t } from '@aethervtt/shard-core'
import { Transform } from '@aethervtt/shard-transform'

// Walls, openings and floors (0055), in world units (metres by convention). A host converts its
// own coordinates with one fixed visual scale; game distance ("5 ft per square") never places
// anything.

const LEVEL_FIELD = {
  level: t.entity({
    description:
      'The Level it stands on (0067). Empty is the ground level; elevation is relative to the level.',
  }),
}

/** A light channel (0069): `sight` (unset) follows the sight channel. */
export const LIGHT_CHANNELS = ['sight', 'normal', 'none'] as const

const lightField = (what: string) =>
  t.enum(LIGHT_CHANNELS, {
    description: `Whether ${what} blocks light (0069): sky light spilling in, and wall-blocked lights. sight (unset) follows its sight channel; set it for a curtain that blocks sight but not light, or the opposite.`,
  })

export const Level = defineComponent(
  'structure/Level',
  {
    index: t.i8({
      min: -16,
      max: 15,
      description:
        'Stacking order: a cellar is -1, the ground level 0. Use it as the GroundLayer.level of what stands on the level.',
    }),
    elevation: t.f32({
      unit: 'm',
      description: "Where the level's floor stands (y). Pieces on it are placed relative to it.",
    }),
    height: t.f32({ default: 3, min: 0, unit: 'm', description: 'Floor to ceiling.' }),
    interiorAmbient: t.vec3({
      unit: 'cd/m²',
      description:
        "Interior lighting (0069): ambient light where the sky doesn't reach, linear colour, added to interiorFill's share of the sky's. A cellar darker than a hall.",
    }),
    interiorFill: t.f32({
      default: 0.05,
      min: 0,
      max: 1,
      description:
        "Interior lighting (0069): the share of the view's sky ambient (uniform or image-based) kept where the sky doesn't reach.",
    }),
  },
  {
    description:
      'A level (0067): its walls, floors and roofs compile into its own group of chunk meshes, children of this entity, so Visibility on it hides the level without a rebuild.',
    requires: [Transform],
  },
)

export const WALL_SHAPES = ['straight', 'arc', 'bezier'] as const

export const Wall = defineComponent(
  'structure/Wall',
  {
    a: t.vec2({ description: 'Start of the centreline, (x, z) in world units.' }),
    b: t.vec2({ description: 'End of the centreline, (x, z) in world units.' }),
    height: t.f32({ default: 3, min: 0, unit: 'm', description: 'Height above elevation.' }),
    thickness: t.f32({ default: 0.2, min: 0, unit: 'm', description: 'Full thickness.' }),
    elevation: t.f32({ unit: 'm', description: 'Where the wall stands (y), above its level.' }),
    ...LEVEL_FIELD,
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
    light: lightField('it'),
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
    light: lightField('it, closed,'),
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
    elevation: t.f32({ unit: 'm', description: 'Height of the floor (y), above its level.' }),
    thickness: t.f32({
      min: 0,
      unit: 'm',
      description:
        'Slab thickness below the surface: 0 draws the top only; more adds the underside, the edges and the rims of its cutouts.',
    }),
    material: t.handle('Material', { description: 'Surface material. Empty uses a plain grey.' }),
    ...LEVEL_FIELD,
  },
  {
    description:
      'A flat floor polygon, triangulated once per edit (with its cutouts as holes) and clipped into chunks.',
  },
)

export const Roof = defineComponent(
  'structure/Roof',
  {
    points: t.list(t.vec2, {
      description: 'Footprint, (x, z): a simple polygon of 3 to 256 points, either winding.',
    }),
    height: t.f32({
      default: 3,
      min: 0,
      unit: 'm',
      description: "The eaves' height above its level's elevation.",
    }),
    pitch: t.f32({
      min: 0,
      max: 80,
      unit: 'deg',
      description: '0 is flat; more is one slope rising toward ridge from the lowest point.',
    }),
    ridge: t.vec2({ default: [0, 1], description: 'The direction the slope rises, (x, z).' }),
    thickness: t.f32({ default: 0.2, min: 0, unit: 'm', description: 'Measured straight down.' }),
    material: t.handle('Material', { description: 'Surface material. Empty uses a plain grey.' }),
    shadowWhenHidden: t.bool({
      default: true,
      description: 'While hidden (Visibility), it still casts shadows, keeping the interior dark.',
    }),
    cutaway: t.bool({
      description:
        "Opens around cameras' reveal points (CutawayView, 0070) instead of hiding whole: its chunk meshes, hatches and skylights are Cutaway. It still casts whole.",
    }),
    ...LEVEL_FIELD,
  },
  {
    description:
      'A roof (0067): its own group of chunk meshes, children of this entity, so it hides alone and nothing under it rebuilds.',
    requires: [Transform],
  },
)

export const CUTOUT_KINDS = ['hole', 'hatch', 'skylight'] as const

export const Cutout = defineComponent(
  'structure/Cutout',
  {
    host: t.entity({ description: 'The Floor or Roof it cuts.' }),
    points: t.list(t.vec2, {
      description: 'The hole, (x, z): a simple polygon inside its host, either winding.',
    }),
    kind: t.enum(CUTOUT_KINDS, {
      description: 'hole (a gap), hatch (a leaf that swings up) or skylight (glass).',
    }),
    frameWidth: t.f32({
      default: 0.06,
      min: 0,
      unit: 'm',
      description: 'Width of the frame around the hole, on the host surface.',
    }),
    frameDepth: t.f32({
      default: 0.03,
      min: 0,
      unit: 'm',
      description: 'How far the frame stands above the host surface.',
    }),
    frameMaterial: t.handle('Material', {
      description: 'Frame and hatch leaf material. Empty uses the built-in wood (structure:frame).',
    }),
    hinge: t.u16({
      description:
        'Hatches: the outline edge the leaf hangs from (edge i runs from point i to i + 1).',
    }),
    state: t.enum(DOOR_STATES, {
      description: 'Hatches: a change swings the leaf and rebuilds no geometry.',
    }),
  },
  { description: 'A hole, hatch or skylight cut into a floor or a roof (0067).' },
)

export const StructureChunk = defineComponent(
  'structure/Chunk',
  {
    group: t.entity({
      readonly: true,
      description: 'The group it belongs to: a Level, a Roof, or the ground level.',
    }),
    x: t.i32({ readonly: true, description: 'Chunk column (x / chunkSize).' }),
    z: t.i32({ readonly: true, description: 'Chunk row (z / chunkSize).' }),
  },
  {
    description:
      "One group's geometry in one chunk and one material, rebuilt by structure compile.",
    serialize: false,
    save: false,
  },
)

export const DoorLeaf = defineComponent(
  'structure/DoorLeaf',
  {
    opening: t.entity({
      readonly: true,
      description: 'The Opening (a door or window) or Cutout (a hatch or skylight) it belongs to.',
    }),
    angle: t.f32({ readonly: true, description: 'How far open, 0 (closed) to 1 (open).' }),
  },
  {
    description:
      'A door leaf (or a window pane) that structure spawns for an opening. Picks resolve through `opening`.',
    serialize: false,
    save: false,
  },
)

/** A chunk's contact shade mesh (0068): one per (group, chunk) with walls near floors. */
export const ContactMesh = defineTag('structure/ContactMesh', { serialize: false, save: false })

/** Glass in a window: a pane that structure spawns and keeps. */
export const WindowPane = defineTag('structure/WindowPane', { serialize: false, save: false })

/** Contact shade (0068): noisy dark strips where walls meet floors and each other. */
export interface ContactSettings {
  /** false despawns every contact mesh: no draws, no compile work. */
  enabled: boolean
  /** Floor strips run from a wall's face out this far (m). */
  floorReach: number
  /** Corner strips run from a joint along the face this far (m). */
  cornerReach: number
  /** Alpha scale of the falloff. */
  opacity: number
  /** Alpha never goes above this. */
  maxAlpha: number
  /** What it darkens toward: linear, display-referred. */
  color: [number, number, number]
  /** How far the noise moves a strip's edge, as a share of its reach (0 to 1). */
  wobble: number
}

/** Contact shade's defaults: Aether's, in metres. */
export function defaultContact(): ContactSettings {
  return {
    enabled: true,
    floorReach: 0.7,
    cornerReach: 0.43,
    opacity: 0.2,
    maxAlpha: 0.42,
    color: [0.0033, 0.0052, 0.008],
    wobble: 0.2,
  }
}

export const INTERIOR_QUALITIES = ['low', 'medium', 'high'] as const
export type InteriorQuality = (typeof INTERIOR_QUALITIES)[number]

/** Interior lighting (0069), with interiorLightingPlugin. */
export interface InteriorSettings {
  /** Sky visibility: ambient and image-based light scaled by how much sky reaches a point. */
  sky: boolean
  /** Point and spot lights with blockedByWalls are occluded by their level's walls. */
  blockLights: boolean
  /** low: 0.5 m field, 256 bins, 1 tap; medium: 0.25 m, 512, 3; high: 0.125 m, 1024, 5. */
  quality: InteriorQuality
  /** How far sky light spills through an opening (m): the field's screening length. */
  spillReach: number
  /** Rows for blocked lights; more are lit unblocked, with structure/too-many-blocked-lights. */
  maxBlockedLights: number
}

/** Interior lighting's defaults. */
export function defaultInterior(): InteriorSettings {
  return { sky: true, blockLights: true, quality: 'medium', spillReach: 3, maxBlockedLights: 256 }
}

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
  /**
   * Contact shade (0068). A patch may hold only the fields it changes: the rest keep their values.
   * Turning it off or on, or changing a reach, rebuilds only contact meshes; the other fields
   * rebuild nothing.
   */
  contact: ContactSettings
  /**
   * Walls open around cameras' reveal points (0070): wall pieces (frames included) draw in meshes
   * of their own, apart from floors, tagged Cutaway, and so are door leaves and window panes.
   * Changing it rebuilds every chunk with walls.
   */
  cutawayWalls: boolean
  /**
   * Interior lighting (0069), with interiorLightingPlugin. A patch may hold only the fields it
   * changes. Turning a part off frees its texture; quality or spill reach re-solves the field and
   * rebuilds every row once.
   */
  interior: InteriorSettings
}

export const StructureSettings = defineResource<StructureSettingsValue>('structure/Settings', {
  description:
    'Chunk size, door swing time, reduced motion, curve tolerance, contact shade, cutaway walls and interior lighting. Write with patchResource.',
  init: () => ({
    chunkSize: 8,
    doorSwingMs: 250,
    reducedMotion: false,
    curveTolerance: 0.01,
    contact: defaultContact(),
    cutawayWalls: false,
    interior: defaultInterior(),
  }),
  hostWritable: true,
})
