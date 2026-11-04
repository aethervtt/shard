# Look at the game

- `shard screenshot <scene> --out shot.png --frames 60` renders headless (no window needed).
- With the MCP server: `screenshot` returns the image; `step` advances frames; `press`/`hold`
  drive input; `query_entities` / `get_entity` read state; `recent_errors` shows what failed.
