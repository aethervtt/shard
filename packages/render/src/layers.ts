import { defineComponent, t } from '@aethervtt/shard-core'
import { Transform } from '@aethervtt/shard-transform'

// Tabletop layers (0057): render layers pick which cameras draw a renderable, and ground bands
// stack coplanar content on a floor in a fixed order at any view angle.

/**
 * Which cameras draw this renderable: it draws in a view when `mask & Camera3d.layers` is
 * nonzero. Absent means layer 1. Culling tests it first, so a hidden visual costs no draw.
 */
export const RenderLayers = defineComponent(
  'render/RenderLayers',
  {
    mask: t.u16({
      default: 1,
      description:
        'Layer bits, 16 layers (1 is layer 1). A camera draws it if any bit is also in its layers.',
    }),
  },
  {
    description:
      'Per-view visuals: a token keeps its Transform on a root, and each child visual (a flat disc, a standee) carries the layer of the camera that shows it.',
  },
)

/**
 * The default ground bands, bottom to top. A host may renumber them; only the order matters.
 * Floors are opaque, write depth, and sit under every band.
 */
export const GROUND_BANDS = {
  tiles: 10,
  grid: 20,
  drawings: 30,
  'tokens-flat': 40,
  fog: 50,
  overlay: 60,
} as const

export type GroundBand = keyof typeof GROUND_BANDS

/**
 * Bands from this one up draw after the transparent phase and projected fog (0058), so fog never
 * covers them: selection rings, pings, measurement templates.
 */
export const OVERLAY_BAND = GROUND_BANDS.overlay

/**
 * Coplanar content on a floor, drawn after opaque geometry in `(band, order)` order with the depth
 * test on and depth writes off: walls and props in front hide it, and bands never fight each other.
 * Ground renderables cast no shadows.
 */
export const GroundLayer = defineComponent(
  'render/GroundLayer',
  {
    band: t.i16({
      default: GROUND_BANDS.drawings,
      presets: GROUND_BANDS,
      description:
        'Stacking band: tiles 10, grid 20, drawings 30, tokens-flat 40, fog 50, overlay 60. Higher draws over lower. Bands from 60 up draw after transparent objects and projected fog.',
    }),
    order: t.i32({ description: 'Order within the band: higher draws over lower.' }),
    level: t.i8({
      min: -16,
      max: 15,
      description:
        'Structure level index (0067): ground layers sort by level first, so a lower level never draws over an upper one. 0 is the ground level.',
    }),
  },
  {
    description:
      'Draws a mesh in the ground phase: coplanar layers in a fixed order, hidden by walls and props, never z-fighting.',
    requires: [Transform],
  },
)
