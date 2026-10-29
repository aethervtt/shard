# Make a HUD

Add `"ui"` to `plugins` in `shard.json`. UI is entities: a `ui/UiRoot` fills the screen, and
`ui/UiNode` children lay out by flexbox (`direction`, `justify`, `alignItems`, `grow`, `gap`,
`padding` and `margin` as top, right, bottom, left). Sizes are pixels, `"50%"`, or `"auto"`.
Make the HUD a prefab, `prefabs/hud.prefab.json`, and place it in the scene with
`scene/PrefabInstance`:

```json
{ "version": 1, "root": { "name": "hud", "components": {
    "ui/UiRoot": { "scale": "fit-height", "referenceSize": [1920, 1080],
      "theme": { "path": "ui/hud.theme.json" } },
    "ui/UiNode": { "padding": [24, 24, 24, 24], "justify": "space-between" } },
  "children": [
    { "name": "fuel", "components": { "ui/UiNode": { "style": "panel", "width": 260 } },
      "children": [{ "name": "label", "components": { "ui/UiText": { "text": "Fuel 100%" } } }] },
    { "name": "scan", "components": { "ui/UiNode": { "style": "button", "padding": [8, 16, 8, 16] },
        "ui/UiButton": {} },
      "children": [{ "name": "label", "components": { "ui/UiText": { "text": "Scan" } } }] }
  ] } }
```

- Looks: `ui/UiStyle` (background, borderColor, borderWidth, radius, opacity), `ui/UiText`
  (text, size, color, font, align, wrap), `ui/UiImage` (texture or atlas region, `slice` for
  nine-slice, `fit`). A `*.theme.json` names styles; nodes pick one with `UiNode.style`, and
  `"button:hovered"` (on, focused, hovered, pressed, disabled) overrides a state. Fields a node sets
  win over its theme. Saving the theme restyles the running game.
- Text needs a font: `UiText.font`, the theme's `font`, or the `ui/UiDefaults` resource.
- Widgets: `ui/UiButton`, `ui/UiToggle` (`on`), `ui/UiSlider` (`value`, `min`, `max`, `step`),
  `ui/UiTextInput` (`value`, shown through its UiText). Systems read `ui/UiClick` and
  `ui/UiChanged` events. A click on UI never reaches gameplay actions or world picking.
- Bind text from a system: `world.set(label, UiText, { text: \`Fuel \${pct}%\` })`. Setting the
  same text again costs nothing.
- Markers over planets: a node with `ui/UiAnchor` (`target` entity path, `clamp`, `hideBehind`,
  `scaleDistance`) and an optional `ui/UiAnchorArrow` child that points at an off-screen target.
- Keyboard and gamepad: Tab moves focus; arrows and the D-pad move it; Enter, Space, or south
  presses. Focus a menu's first button with `ui_focus` or `focusUi(world, entity)`.

Check it as data, not pixels: `ui_describe` gives each node's rect, text, and state, and
`ui_click` presses a button by path. In gameplay tests:

```ts
await game.ui.click('hud/scan')
await game.step(1)
expect(await game.ui.node('fuel/label')).toMatchObject({ text: 'Fuel 100%', visible: true })
```

Turn on the `ui-layout` overlay (`debug_overlays`) to see node rects, padding, and margins.
