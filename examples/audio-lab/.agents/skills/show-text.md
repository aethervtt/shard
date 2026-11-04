# Show text

Add `"text"` to `plugins` in `shard.json` and put a `.ttf` or `.otf` under `assets/` (import
settings: `charset`, `size`, `range`, `fallback` fonts for missing characters).

- In the world: `"text/Text": { "value": "Scanner 7", "font": { "path": "assets/fonts/Inter.ttf" },
  "size": 0.5, "billboard": true }`. `size` is the em height in meters.
- On screen: `"text/ScreenText": { "value": "Fuel 82%", "font": ..., "size": 24, "corner":
  "top-right", "position": [-16, 16] }` (pixels from the corner, y down).
- Style: `outline: { width: 0.03, color }`, `shadow: { offset: [0.05, -0.05], softness: 0.3, color }`
  (offset 0 with softness is a glow), `weight`. Wrap with `maxWidth`; `align` and `anchor` place it.
- Size before placing: MCP `measure_text` returns width, height, and lines. `preview_asset` on the
  font shows a specimen. Missing characters: `render.describe` → `text.missing`.
