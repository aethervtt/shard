# Coordinate reusable effect sequences

Enable "effects" in shard.json and the plugins used by your tracks: "animation", "particles",
"audio/events" and "render/forward" for visual tracks. The scene plugin handles owned prefab targets. Author *.effect-sequence.json
against .shard/schemas/effect-sequence.schema.json. Hosts may supply the same JSON directly;
all dependencies resolve through the host's AssetServer catalog, including GUID-only assets.

A sequence has duration, parameters, named targets and tracks. Targets with a prefab handle
are spawned/owned; other targets are borrowed entity bindings. Property tracks interpolate
float/vector/color component fields (from/to arrays, linear or smoothstep, optional parameter
multiplier). Animation and particle tracks require owned targets. Audio tracks use authored
AudioEvent assets. Visual tracks require owned targets and name render/Trail, render/Beam or
render/Decal in component. They activate playing, pause their clocks, and stop at track end;
trails drain their remaining history. Beam tracks may bind an endpoint by target name.
Marker tracks record presentation milestones; gameplay applies damage itself.

Use prepareEffect(world, source), then playEffect(world, preparation, { bindings, parameters,
seed, parent, ownerEntity }). The optional parent anchors owned targets in a local frame, so
one prepared spell can play at different positions/orientations. Removing the parent cancels
the effect unless another ownerEntity was supplied. Release the preparation when no more plays are needed: active instances
retain it. cancelEffect restores borrowed fields, stops audio and removes owned prefab trees.
pauseEffect pauses only that instance. Keep claimed fields free of other writers while playing.
No runtime file picker, URL fetcher or persistence backend is assumed.

Protocol/MCP: effects.prepare, effects.play, effects.pause, effects.cancel, effects.release,
effects.inspect (trace cursor, active instances and preparation references). The inspect trace
reports late windows skipped after a large frame step. A missing target fails and cleans up the
whole instance. Calls return structured effects/* errors. Dispose the app to release all plans.

Preview at playground/effects.html; its spell asset and host catalog adapter demonstrate the
complete flow. Replay by cancelling and playing again; backward scrubbing is not implemented.
