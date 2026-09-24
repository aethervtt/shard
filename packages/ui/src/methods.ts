import { defineSchema, type Entity, findComponent, ShardError, t, type World } from '@shard/core'
import type { AppMethod } from '@shard/runtime'
import {
  UI_ANCHOR_STATES,
  UI_STATES,
  UiInteraction,
  UiNode,
  UiSlider,
  UiText,
  UiTextInput,
  UiToggle,
} from './components'
import { clickUi, focusUi, UiPointer } from './interaction'
import { ResolvedStyle, resolveStyle } from './style'
import { Kind, textColumns, type UiRootState, UiState } from './tree'

const round = (x: number) => Math.round(x * 100) / 100
const KINDS = ['', 'button', 'toggle', 'slider', 'text-input'] as const

/** An entity's scene path, if it came from a scene. */
export function uiPath(world: World, entity: Entity): string | null {
  const member = findComponent('scene/SceneMember')
  if (!member || !world.isAlive(entity)) return null
  return (world.tryGet(entity, member) as { path?: string } | undefined)?.path || null
}

/**
 * A UI node by id or scene path. A path may also be a suffix after "/" ("play" finds
 * "hud/menu/play") when only one node matches.
 */
export function resolveUiEntity(world: World, ref: unknown): Entity {
  const store = world.resource(UiState)
  if (typeof ref === 'number' && world.isAlive(ref) && store.rootOf.has(ref)) return ref
  if (typeof ref === 'string' && ref !== '') {
    let exact: Entity | undefined
    const suffix: Entity[] = []
    for (const e of store.rootOf.keys()) {
      const path = uiPath(world, e)
      if (!path) continue
      if (path === ref || path.endsWith(`:${ref}`)) exact = e
      else if (path.endsWith(`/${ref}`)) suffix.push(e)
    }
    if (exact !== undefined) return exact
    if (suffix.length === 1) return suffix[0]!
    if (suffix.length > 1) {
      throw new ShardError('ui/ambiguous-path', `"${ref}" matches ${suffix.length} UI nodes`, {
        hint: `Use the full path: ${suffix.map((e) => uiPath(world, e)).join(', ')}.`,
      })
    }
  }
  throw new ShardError('ui/unknown-node', `No UI node ${JSON.stringify(ref)}`, {
    hint: 'Pass an entity id or a scene path of a node under a UiRoot (ui.describe lists them).',
  })
}

const describeStyle = new ResolvedStyle()

interface DescribedNode {
  entity: Entity
  path: string | null
  rect: [number, number, number, number]
  visible: boolean
  [key: string]: unknown
}

function describeNode(
  world: World,
  r: UiRootState,
  i: number,
  focused: Entity | null,
): DescribedNode {
  const e = r.entities[i]!
  const table = world.entityTable(e)
  const row = world.entityRow(e)
  const out: DescribedNode = {
    entity: e,
    path: uiPath(world, e),
    rect: [round(r.x[i]!), round(r.y[i]!), round(r.w[i]!), round(r.h[i]!)],
    visible: r.visible[i] !== 0,
  }
  const style = table.column(UiNode, 'style')[row] ?? ''
  if (style) {
    out.style = style
    if (r.theme && !r.theme.styles.has(style))
      out.problem = `ui/unknown-style: "${style}" isn't in the theme`
  }
  const text = r.texts[i]
  if (text) {
    out.text = table.has(UiTextInput)
      ? table.column(UiTextInput, 'value')[row]
      : table.column(UiText, 'text')[row]
    resolveStyle(describeStyle, textColumns(table), row, r.theme, style, 0)
    out.textSize = round(describeStyle.size)
    if (!text.font) out.problem = 'no font: set UiText.font, a theme font, or UiDefaults.font'
    else if (text.layout.missing > 0) out.missingGlyphs = text.layout.missing
  }
  const kind = r.kind[i]!
  if (kind !== Kind.None) {
    out.widget = KINDS[kind]
    const s = table.has(UiInteraction) ? table.column(UiInteraction, 'state')[row]! : 0
    out.state = UI_STATES[s]
    if (focused === e) out.focused = true
    if (r.disabled[i]) out.disabled = true
    if (kind === Kind.Toggle) out.on = table.column(UiToggle, 'on')[row] !== 0
    if (kind === Kind.Slider) out.value = round(table.column(UiSlider, 'value')[row]!)
  }
  if (r.anchorKind[i] === 1) {
    out.anchor = UI_ANCHOR_STATES[r.anchorState[i]!]
    out.distance = round(r.distance[i]!)
    if (r.anchorScale[i] !== 1) out.scale = round(r.anchorScale[i]!)
  }
  if (r.anchorKind[i] === 2) out.arrowAngle = round(r.angle[i]!)
  if (r.overflow[i] === 2) {
    out.scroll = [round(r.scrollX[i]!), round(r.scrollY[i]!)]
    out.content = [round(r.contentW[i]!), round(r.contentH[i]!)]
  }
  const children: DescribedNode[] = []
  for (let c = i + 1; c < r.end[i]!; c = r.end[c]!)
    children.push(describeNode(world, r, c, focused))
  if (children.length > 0) out.children = children
  return out
}

/** Hooks other parts of the plugin add to describe (the renderer's upload counts). */
export const describeExtras = new Map<string, (world: World) => unknown>()

/** Every UI tree as data: rects, text, widget state, focus, anchors, and this frame's work. */
export function describeUi(world: World, root?: Entity) {
  const store = world.resource(UiState)
  const pointer = world.resource(UiPointer)
  const roots = store.roots
    .filter((r) => root === undefined || r.entity === root)
    .map((r) => ({
      entity: r.entity,
      path: uiPath(world, r.entity),
      size: [round(r.width), round(r.height)],
      scale: round(r.factor),
      viewport: [r.viewportW, r.viewportH],
      camera: r.camera,
      nodes: r.count,
      laidOutAt: r.laidOutAt,
      tree: describeNode(world, r, 0, pointer.focused),
    }))
  const extras: Record<string, unknown> = {}
  for (const [name, fn] of describeExtras) extras[name] = fn(world)
  return {
    roots,
    focus: pointer.focused === null ? null : (uiPath(world, pointer.focused) ?? pointer.focused),
    hovered: pointer.hovered === null ? null : (uiPath(world, pointer.hovered) ?? pointer.hovered),
    pointer: { x: round(pointer.x), y: round(pointer.y), overUi: pointer.overUi },
    frame: {
      layouts: store.layouts,
      nodesLaidOut: store.nodesLaidOut,
      repositions: store.repositions,
      flexCalls: store.flexCalls,
      ...extras,
    } as { layouts: number; nodesLaidOut: number; repositions: number; flexCalls: number } & Record<
      string,
      unknown
    >,
    problems: [...store.orphans].map((e) => ({
      code: 'ui/no-root',
      entity: e,
      path: uiPath(world, e),
    })),
  }
}

export const uiMethods: AppMethod[] = [
  {
    name: 'ui.describe',
    description:
      "Every UI tree (or one root) as data: each node's path, rect [x, y, width, height] in the root's pixels, visibility, text and size, style, widget kind and state (hovered, pressed, disabled, focused, on, value), anchor state (on-screen, clamped, hidden) and distance, scroll; the focused and hovered nodes; and this frame's layout and upload counts (0 on a frame where nothing changed).",
    params: defineSchema('ui/DescribeParams', {
      root: t.json({ description: 'A UiRoot entity id or path (default: all).' }),
    }),
    handler: ({ world }, p) =>
      describeUi(
        world,
        p.root === undefined || p.root === null ? undefined : resolveUiEntity(world, p.root),
      ),
  },
  {
    name: 'ui.click',
    description:
      'Clicks a UiButton or UiToggle by entity id or path (a unique suffix like "play" works): sends ui/UiClick and flips a toggle, as a real click does, with no pixel coordinates. Takes effect now; step a frame for systems to react.',
    params: defineSchema('ui/ClickParams', {
      entity: t.json({ description: 'Entity id or scene path of the button.' }),
    }),
    handler: ({ world }, p) => {
      const e = resolveUiEntity(world, p.entity)
      clickUi(world, e)
      return { clicked: e, path: uiPath(world, e) }
    },
  },
  {
    name: 'ui.focus',
    description:
      'Gives keyboard and gamepad focus to a widget by id or path (null clears it). While a node has focus, action maps in the game context are paused.',
    params: defineSchema('ui/FocusParams', {
      entity: t.json({ description: 'Entity id or scene path, or null.' }),
    }),
    handler: ({ world }, p) => {
      const e =
        p.entity === null || p.entity === undefined ? null : resolveUiEntity(world, p.entity)
      focusUi(world, e)
      return { focused: e, path: e === null ? null : uiPath(world, e) }
    },
  },
]
