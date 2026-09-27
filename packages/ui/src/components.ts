import {
  type AssetRef,
  defineComponent,
  defineEvent,
  defineResource,
  defineTag,
  type Entity,
  type Infer,
  t,
} from '@aethervtt/shard-core'
import { uiLength } from './length'

export const UI_DISPLAYS = ['flex', 'none'] as const
export const UI_POSITIONS = ['relative', 'absolute'] as const
export const UI_DIRECTIONS = ['row', 'column', 'row-reverse', 'column-reverse'] as const
export const UI_JUSTIFY = [
  'start',
  'center',
  'end',
  'space-between',
  'space-around',
  'space-evenly',
] as const
export const UI_ALIGN = ['stretch', 'start', 'center', 'end'] as const
export const UI_ALIGN_SELF = ['auto', 'stretch', 'start', 'center', 'end'] as const
export const UI_OVERFLOW = ['visible', 'clip', 'scroll'] as const
export const UI_TEXT_ALIGN = ['start', 'center', 'end'] as const
export const UI_FIT = ['fill', 'contain', 'cover'] as const
export const UI_SCALES = ['none', 'fit-height', 'fit-width'] as const
export const UI_STATES = ['none', 'hovered', 'pressed', 'disabled'] as const
export const UI_ANCHOR_STATES = ['none', 'on-screen', 'clamped', 'hidden'] as const

/** Computed by layout: the node's rect and what clips it. Managed by the UI plugin. */
export const UiLayout = defineComponent(
  'ui/UiLayout',
  {
    x: t.f32({ readonly: true, description: "Left edge, in the root's pixels." }),
    y: t.f32({ readonly: true, description: "Top edge, in the root's pixels." }),
    width: t.f32({ readonly: true, description: 'Border-box width.' }),
    height: t.f32({ readonly: true, description: 'Border-box height.' }),
    clip: t.vec4({
      readonly: true,
      description:
        'The visible region (x, y, width, height) after ancestors that clip or scroll; zero size when nothing shows.',
    }),
    content: t.vec2({
      readonly: true,
      description: 'Size of what the children cover: the scrollable extent of a scroll node.',
    }),
    scale: t.f32({
      default: 1,
      readonly: true,
      description: 'Draw scale from a scaling anchor (1: none).',
    }),
    angle: t.f32({
      readonly: true,
      unit: 'rad',
      description: 'UiAnchorArrow: rotation toward an off-screen target.',
    }),
    visible: t.bool({
      readonly: true,
      description:
        'Drawn and hit: false for display none, hidden anchors, and nodes outside a root.',
    }),
    anchor: t.enum(UI_ANCHOR_STATES, {
      readonly: true,
      description: 'UiAnchor nodes: on-screen, clamped to an edge, or hidden (behind the camera).',
    }),
    distance: t.f32({
      readonly: true,
      unit: 'm',
      description: "UiAnchor nodes: the target's distance from the camera.",
    }),
  },
  {
    description:
      "A UI node's computed rect (in pixels of its root's reference size), clip, and anchor state. Written by layout; read it to check where things are.",
    serialize: false,
  },
)

export const UiNode = defineComponent(
  'ui/UiNode',
  {
    display: t.enum(UI_DISPLAYS, { description: 'none: not laid out, drawn, or hit.' }),
    position: t.enum(UI_POSITIONS, {
      description:
        "relative: in the parent's flow (left/top/right/bottom nudge it). absolute: out of flow, placed by left/top/right/bottom in the parent's padding box.",
    }),
    direction: t.enum(UI_DIRECTIONS, { description: 'Main axis children flow along.' }),
    wrap: t.bool({ description: "Wrap children onto new lines when they don't fit." }),
    justify: t.enum(UI_JUSTIFY, { description: 'Distribution of children along the main axis.' }),
    alignItems: t.enum(UI_ALIGN, { description: 'Placement of children on the cross axis.' }),
    alignSelf: t.enum(UI_ALIGN_SELF, { description: "Overrides the parent's alignItems." }),
    width: uiLength({ description: 'Border-box width: pixels, "50%" of the parent, or "auto".' }),
    height: uiLength({ description: 'Border-box height.' }),
    minWidth: uiLength({ description: 'Lower bound on width ("auto": none).' }),
    maxWidth: uiLength({ description: 'Upper bound on width ("auto": none).' }),
    minHeight: uiLength({ description: 'Lower bound on height.' }),
    maxHeight: uiLength({ description: 'Upper bound on height.' }),
    left: uiLength({ description: 'Offset from the left (absolute: of the parent).' }),
    top: uiLength({ description: 'Offset from the top.' }),
    right: uiLength({ description: 'Offset from the right.' }),
    bottom: uiLength({ description: 'Offset from the bottom.' }),
    padding: t.vec4({ min: 0, unit: 'px', description: 'Inside space: top, right, bottom, left.' }),
    margin: t.vec4({ unit: 'px', description: 'Outside space: top, right, bottom, left.' }),
    gap: t.vec2({
      min: 0,
      unit: 'px',
      description: 'Space between children: horizontal, vertical.',
    }),
    grow: t.f32({ min: 0, description: 'Share of free main-axis space this node takes.' }),
    shrink: t.f32({ default: 1, min: 0, description: 'Share of overflow this node gives back.' }),
    basis: uiLength({ description: 'Main size before growing and shrinking ("auto": its size).' }),
    order: t.i16({ description: 'Sorts siblings (stable): lower first.' }),
    zIndex: t.i16({
      description: 'Draw and hit order among siblings: higher draws over, and gets clicks first.',
    }),
    overflow: t.enum(UI_OVERFLOW, {
      description:
        "visible: children may spill out. clip: they're cut at the padding box. scroll: cut, and the wheel scrolls it.",
    }),
    scroll: t.vec2({ min: 0, unit: 'px', description: 'Scroll offset (overflow scroll).' }),
    style: t.string({
      description: 'A style in the root\'s theme ("panel", "button"); fields set here win.',
    }),
  },
  {
    description:
      'A UI box laid out by flexbox under a UiRoot: sizes, flex, spacing, positioning, clipping. Children are ChildOf entities, in order.',
    requires: [UiLayout],
  },
)

export const UiRoot = defineComponent(
  'ui/UiRoot',
  {
    scale: t.enum(UI_SCALES, {
      description:
        'none: one UI pixel per screen pixel. fit-height / fit-width: scale so referenceSize fills the screen that way.',
    }),
    referenceSize: t.vec2({
      default: [1920, 1080],
      min: 1,
      unit: 'px',
      description: 'The size the UI is authored at (and its size headless).',
    }),
    camera: t.entity({
      description: 'The camera whose view it draws over and anchors from (null: the first).',
    }),
    theme: t.handle('UiTheme', { description: 'Styles its nodes name (*.theme.json).' }),
    order: t.i16({ description: 'Draw order among roots: higher draws over.' }),
  },
  {
    description: 'The top of a UI tree: fills the screen and lays out its UiNode children.',
    requires: [UiNode],
  },
)

export const UiStyle = defineComponent(
  'ui/UiStyle',
  {
    background: t.color({ default: [0, 0, 0, 0], description: 'Fill color (linear).' }),
    borderColor: t.color({ default: [0, 0, 0, 0], description: 'Border color (linear).' }),
    borderWidth: t.f32({ min: 0, unit: 'px', description: 'Border thickness, inside the box.' }),
    radius: t.vec4({
      min: 0,
      unit: 'px',
      description: 'Corner radii: top left, top right, bottom right, bottom left.',
    }),
    opacity: t.f32({
      default: 1,
      min: 0,
      max: 1,
      description: 'Multiplies the node and its children.',
    }),
  },
  {
    description:
      'How a node looks: background, border, rounded corners, opacity. Fields at their default take the theme style.',
    requires: [UiNode],
  },
)

export const UiText = defineComponent(
  'ui/UiText',
  {
    text: t.string({ description: 'The text. "\\n" breaks a line.' }),
    key: t.string({
      description:
        "Localization key in the locales/*.strings.json tables: the node shows the current locale's string, and follows locale switches. text shows until it resolves.",
    }),
    params: t.json({
      default: {},
      description:
        'Values for the key\'s {name} placeholders: { "amount": 42 }. Numbers format for the locale; "n" (or "count") picks the plural form.',
    }),
    size: t.f32({ default: 16, min: 0, unit: 'px', description: 'Height of one em.' }),
    color: t.color({ default: [1, 1, 1, 1], description: 'Text color (linear).' }),
    font: t.handle('Font', { description: "Font (null: the theme's, then UiDefaults.font)." }),
    align: t.enum(UI_TEXT_ALIGN, { description: 'Line alignment in the node.' }),
    wrap: t.bool({ default: true, description: 'Wrap at the node width.' }),
    lineHeight: t.f32({
      default: 1.2,
      min: 0.1,
      description: 'Distance between baselines, as a multiple of the size.',
    }),
  },
  {
    description: "A node's text (MSDF): its size sets the node's size unless width/height do.",
    requires: [UiNode],
  },
)

export const UiImage = defineComponent(
  'ui/UiImage',
  {
    texture: t.handle('Texture', {
      description: 'The image (ignored when atlas and region are set).',
    }),
    atlas: t.handle('TextureAtlas', { description: 'An atlas to draw a region of.' }),
    region: t.string({ description: 'Atlas region name.' }),
    slice: t.vec4({
      min: 0,
      unit: 'px',
      description:
        'Nine-slice borders (top, right, bottom, left) in image pixels: corners keep their size, edges and middle stretch. Zero: no slicing.',
    }),
    tint: t.color({ default: [1, 1, 1, 1], description: 'Multiplied in (linear).' }),
    fit: t.enum(UI_FIT, {
      description:
        'fill: stretch to the box. contain: fit inside, keeping aspect. cover: fill, cropping.',
    }),
  },
  {
    description:
      "An image in a node: a texture or atlas region, nine-sliced or fitted. Its pixel size is the node's size unless width/height set it.",
    requires: [UiNode],
  },
)

export const UiInteraction = defineComponent(
  'ui/UiInteraction',
  {
    state: t.enum(UI_STATES, { readonly: true, description: 'Pointer state.' }),
    focused: t.bool({ readonly: true, description: 'Has keyboard and gamepad focus.' }),
  },
  {
    description: 'Hover, press, and focus of an interactive node. Written by the UI plugin.',
    serialize: false,
  },
)

export const UiButton = defineComponent(
  'ui/UiButton',
  { disabled: t.bool({ description: 'Ignores the pointer and focus; state is disabled.' }) },
  {
    description:
      'Clickable: sends ui/UiClick on a click, Enter, Space, or the gamepad south button.',
    requires: [UiNode, UiInteraction],
  },
)

export const UiToggle = defineComponent(
  'ui/UiToggle',
  {
    on: t.bool({ description: 'Checked.' }),
    disabled: t.bool({ description: 'Ignores input.' }),
  },
  {
    description: 'A checkbox or switch: a click flips on and sends ui/UiChanged (and ui/UiClick).',
    requires: [UiNode, UiInteraction],
  },
)

export const UiSlider = defineComponent(
  'ui/UiSlider',
  {
    value: t.f32({ description: 'Current value, min to max.' }),
    min: t.f32({ description: 'Value at the left edge.' }),
    max: t.f32({ default: 1, description: 'Value at the right edge.' }),
    step: t.f32({ min: 0, description: 'Snap to multiples of this from min (0: continuous).' }),
    fill: t.color({
      default: [0.25, 0.55, 1, 1],
      description: "Color of the filled part (min to value), drawn inside the node's padding.",
    }),
    disabled: t.bool({ description: 'Ignores input.' }),
  },
  {
    description:
      'Dragging sets value from the pointer; left and right step it while focused. Sends ui/UiChanged.',
    requires: [UiNode, UiInteraction],
  },
)

export const UiTextInput = defineComponent(
  'ui/UiTextInput',
  {
    value: t.string({ description: 'The text typed.' }),
    placeholder: t.string({ description: 'Shown dimmed while value is empty.' }),
    maxLength: t.u16({ description: 'Most characters (0: no limit).' }),
    disabled: t.bool({ description: 'Ignores input.' }),
  },
  {
    description:
      "A text field: clicking focuses it, typing edits value (sends ui/UiChanged), Enter or Escape blurs. Shows through the node's UiText.",
    requires: [UiNode, UiInteraction],
  },
)

export const UiAnchor = defineComponent(
  'ui/UiAnchor',
  {
    target: t.entity({ description: 'The world entity to follow.' }),
    offset: t.vec3({ unit: 'm', description: "World offset from the target's position." }),
    screenOffset: t.vec2({ unit: 'px', description: 'Offset on screen after projecting, y down.' }),
    pivot: t.vec2({
      default: [0.5, 0.5],
      description: 'Point of the node on the target: [0, 0] top left, [0.5, 1] bottom center.',
    }),
    clamp: t.bool({ description: 'Keep it on screen when the target is off it (or behind).' }),
    margin: t.f32({
      default: 16,
      min: 0,
      unit: 'px',
      description: 'Distance kept from the edge when clamped.',
    }),
    hideBehind: t.bool({ description: 'Hide while the target is behind the camera.' }),
    scaleDistance: t.f32({
      min: 0,
      unit: 'm',
      description: 'Scale by distance: 1 at this distance, larger nearer (0: never scale).',
    }),
    minScale: t.f32({ default: 0.5, min: 0, description: 'Smallest distance scale.' }),
    maxScale: t.f32({ default: 1.5, min: 0, description: 'Largest distance scale.' }),
  },
  {
    description:
      "Places a node over a world entity's screen position (planet markers): positioned absolute, clamped to the edges, hidden behind the camera, scaled by distance. A UiAnchorArrow child points at an off-screen target.",
    requires: [UiNode],
  },
)

export const UiAnchorArrow = defineTag('ui/UiAnchorArrow', {
  description:
    "A child of a UiAnchor node shown only while the anchor is clamped: placed just outside the node's edge toward the target and rotated to point at it (draw it pointing right).",
})

export interface UiEntityEvent {
  entity: Entity
}

export const UiClick = defineEvent<UiEntityEvent>('ui/UiClick', {
  description: 'A button (or toggle) was clicked, activated from focus, or clicked by ui.click.',
})
export const UiChanged = defineEvent<UiEntityEvent>('ui/UiChanged', {
  description: "A toggle, slider, or text input's value changed from input.",
})
export const UiHover = defineEvent<UiEntityEvent & { hovered: boolean }>('ui/UiHover', {
  description: 'The pointer entered (hovered true) or left an interactive node.',
})

export interface UiDefaultsValue {
  /** Font for text without one (and no theme font). */
  font: AssetRef<'Font'> | null
}

export const UiDefaults = defineResource<UiDefaultsValue>('ui/UiDefaults', {
  description: 'Fallbacks: the font UI text uses when neither it nor its theme names one.',
  init: () => ({ font: null }),
})

export type UiNodeValue = Infer<typeof UiNode>
export type UiStyleValue = Infer<typeof UiStyle>
export type UiTextValue = Infer<typeof UiText>
