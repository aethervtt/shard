# Change game code and see it run

1. Edit a system or component in `scripts/`. The running game (MCP server, `shard dev` page)
   rebuilds and hot reloads on save, keeping every entity and resource.
2. Check it took: MCP `project_status` (or the note in `step`'s result). A failed build or reload
   reports `source` as `scripts/<file>.ts:line:col`, and the previous code keeps running.
3. `step` some frames and `screenshot` or `get_entity` to see the effect.
4. Run `typecheck` (`shard check --json`): reloads don't wait for type errors.
5. Changing a component's fields migrates live data: new fields take their defaults, removed ones
   are dropped. To rename a field, bump the component's `version` and move the value in `migrate`.
