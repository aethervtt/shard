# 0115 — Representation tiers: hordes of animated characters

- **Status:** accepted (2026-11-13). Built on 0114 and 0116; implemented once its criteria pass in CI.
- **Packages:** `@aethervtt/shard-characters` (new; `./net` for hordes), `@aethervtt/shard-animation`,
  `@aethervtt/shard-render`, `@aethervtt/shard-nav`, `@aethervtt/shard-physics`,
  `@aethervtt/shard-partition`
- **Depends on:** 0022, 0032, 0033, 0034, 0037, 0087, 0103, 0112, 0113, 0114, 0116

## Context

A Project Zomboid-like game has hundreds of zombies in view at once, some at arm's length and some
across a field. Its people are composed per character: one MakeHuman body (Risen's ADR 0003) on a
53-joint rig, clothing items worn on the same rig, and a body shape made of morph weights plus
joint offsets. Today every character costs the same at any distance:

- Each has its own joint entities: 500 zombies make about 26,000 entities in transform propagation.
- `animation/sample` samples every player every frame. `render/prepare-deforms` writes joint
  matrices for every slot that isn't hidden (`ComputedVisibility` is the hierarchy flag, not the
  frustum), so off-screen characters cost as much as visible ones.
- There's no animation LOD, and nothing is measured past 200 characters (0032).
- The Detour crowd is budgeted at 100 agents in 1.5 ms (0037), and a horde is several hundred
  agents moving at once, on the server too.
- 0113 replicates zombies within `replicate.range` (160 m), while cells draw to 512 m, so a horde
  across a field is invisible. 0113 left that to this spec.

The zoo project is no precedent. Its animals have 27–28 joints, move by grid A* without a crowd,
and get no animation LOD or off-screen skipping.

This spec gives each character one **representation tier** at a time, chosen per frame with
hysteresis, as Unreal's Mass does (MassLOD, MassRepresentation). It gives agents a **movement
tier**, and shows far hordes past replication.

## Goals

- Four tiers. **Near:** joint entities, graph, IK, attachments (today). **Mid:** no joint entities;
  pose sampled into a per-character pose buffer at a rate falling with screen size; no IK.
  **Far:** no per-frame CPU; clips baked to bone matrices, played on the GPU by clip and start
  time, on 0103's LODs. **Off:** not drawn or sampled; time, events and movement go on.
- Tier swaps are seamless: the skinned vertices match on either side of a swap.
- Characters composed per instance (body parts and worn items on one skeleton) share one pose range
  and one bake. Body-shape morphs work on every tier, and shapes that move joints come from a
  palette of builds.
- Pinned characters (players) stay near whatever the caps say.
- Tiers are a component game code reads, with a staggered tick flag for its own AI.
- Movement tiers: Detour crowd near players, cheaper steering further out, flow fields for many
  agents heading to one goal, with 0114's breaching in every tier. All of it works on a headless
  server, with tiers from player distance.
- Zombies beyond `replicate.range` show on clients at the far tier.

## Non-goals

- Zombie AI and perception (0048 stays later), damage and hit detection, moving dormant hordes.
- Shadow rendering (0116). This spec only feeds it (see Shadows).
- Continuous joint offsets per character; atlasing a character into one draw; impostors; LOD
  crossfades (0022).

## Design

### Rigs and composed characters

A `CharacterRig` (`*.character.json`, data asset) is what characters on one skeleton share:

- **Skeleton:** joint paths, parents, rest TRS and inverse binds, from a skinned model's skin.
- **Clips:** the clip set, and which of them `far` bakes. Retargeting (0034) applies as usual.
- **Shapes** (optional): a table in Risen's `body.json` form, `{ morphs, bones[morph][joint],
  pelvisLift[morph] }`. A morph with bone offsets *moves joints*; one without is *free*.
- **Builds:** a palette. Each build is a set of weights for joint-moving morphs. Its rest pose is
  the skeleton's plus `Σ weight × offset` per joint, and its retarget root's translation is lifted
  by `Σ weight × pelvisLift`. Build 0 is the plain skeleton.
- **Mesh rules:** `minTier` by part name (eyelashes stop at mid). `far.merge` lists parts drawn as
  one merged mesh at far, as the body regions are (below).

A character is the rig, one build, a list of **parts** chosen per instance, and morph weights:

```ts
spawnCharacter(world, rig, {
  build: 'heavy',                                   // palette entry; default 0
  parts: [...partsOf(world, baseModel, { hide: ['body-torso'] }), ...partsOf(world, jacket)],
  morphs: { 'muscle-max': 0.4 },                    // free morphs; the build adds its own
  transform: { translation: [40, 0, 12] },
})
```

- `partsOf(world, model)` lists a loaded model's skinned nodes as `{ name, mesh, material }`. Parts
  come from any model on the rig's skeleton: same joint names, inverse binds within 1e-4
  (`characters/skeleton-mismatch` otherwise). Each part is an entity (`Mesh3d`, `SkinnedMesh`,
  `MorphWeights`), and joints aren't spawned. Parts aren't the root's children: a moving root
  would have propagation recompute all of them, drawn or not (2.2 ms for 2,000 characters of 13
  parts). `characters/sample` copies the root's world matrix into the parts a tier draws instead,
  and removing a character despawns its parts.
- **One pose and one bake per character.** Parts share inverse binds, so every part's deform
  record points at the same pose range (mid) or the same baked playback (far).
- **Morph weights are static per character**: the build's plus `morphs`. A joint-moving morph named
  in `morphs` warns (`characters/morph-moves-joints`) and is ignored. Weights are packed once
  into a persistent `(index, weight)` block that every part's record points at, so they cost
  nothing per frame on any tier, far included. 0103's levels carry the morph deltas.
- **Bakes are per build.** A bake holds `frames × 53 × 48 B`. Eight far clips of 1.5 s at 30 fps
  are 916 KB a build and take about 2 ms to bake at load. Every build's bake sits in one `@data`
  array. At WebGL2's floor, that array holds 32 MB (2048 rows of 1024 texels), so **a game can
  afford about 32 builds** of that clip set. The full tier allows more, so a game targeting it
  can raise the count. `characters.describe` reports the bytes. Clips bake as authored, which
  is what mid samples without root motion. `far.pin` bakes clips that travel in place instead.
- **Far merge.** At load, the rig concatenates the `far.merge` parts' LOD levels (level k from
  each part's level k, or its last), giving one mesh per level. They need the same material.
  At far, a character draws the merged body instead of those parts, with hidden regions
  included under the clothes. That's 1 slot instead of 9 for Risen's body.

### Tier selection (`characters/select`)

Runs in PostUpdate after `TransformSystems` and before `computeVisibility`, so it sees this
frame's cameras and roots, and a hidden or shown mesh takes effect the same frame.

- **Viewers** are cameras with `TierSource { viewer: true }`. A character's screen size is its
  sphere's diameter over the viewport height (0022's measure), the largest over the viewers.
- **Pinned** (`CharacterTier.pin`) characters are near on every frame, whatever the caps, frustum
  or size say, and don't count toward `maxNear`. Every player's character uses it, and the local
  player's always does: true first person needs its rig and IK. The rig pool grows by the pinned
  count.
- **Off:** beyond `farDistance`, below `far.screen`, or outside every viewer frustum while 0116's
  `casterRelevant(world, viewer, center, radius)` is false for every viewer. The sphere is the
  one the character's body slot uses. **Near / mid / far:** by screen thresholds. Near and mid
  have caps (`maxNear`, `maxMid`), filled by screen size, largest first. Incumbents rank with a
  `hysteresis` bonus, so caps don't flicker.
- A tier changes only past a threshold by more than `hysteresis`, and not within `dwell` seconds
  of the last change. The exceptions: entering or leaving `off` is immediate.
- At most `joinsPerFrame` unpinned characters enter near in a frame. The rest wait in mid.
- **Sim tier** (`CharacterTier.sim`) comes from the distance to the nearest `TierSource
  { player: true }`, thresholds `simNear` and `simMid`. `simTick` is true on frames this entity's
  period (`simEvery[sim]`) comes due, staggered by entity id. Game AI checks it.
- **Headless** (no viewers): `tier` follows `sim`. Without `serverRigs`, a server never gives
  out a rig, pinned or not: near acts as mid, which samples nothing without a renderer.

### Swaps

- **Mid → near:** a rig (joint entities at the skeleton's paths) is taken from the pool for the
  skeleton, and parked under the root in the build's rest pose. Every part's `SkinnedMesh.joints`
  points at it, and the player rebinds from that rest pose (cold path): retargeting corrects
  against what a joint holds when it binds, so a rig posed mid-stride would bind wrong. On the swap
  frame the parts still draw the flat pose, sampled at this frame's time. They skin by the rig
  from the next frame, once the player has sampled it. IK weights fade in over `ikFade`.
- **Near → mid:** IK weights fade to 0 over `ikFade` while still near, then the rig returns to
  the pool. Pooled rigs are unparented and unchanged, so propagation recomputes nothing in them.
- **Mid ↔ far:** the far header is written from the layers' current clips and times. `far.merge`
  parts are swapped for the merged body. Leaving far, mid samples on the swap frame.
- **Any → off:** parts hidden (`Visibility`). Off → any samples or writes the header the same
  frame.

Layers live on `AnimationPlayer` in every tier, so time is continuous across swaps. Only IK
(faded out first), dropped layers (far, below) and bake interpolation can differ.

### Animation on each tier (`@aethervtt/shard-animation`)

- `animation/sample` splits into time (`advance`, fades, events) and sampling. **Time runs on
  every tier**, so `AnimationEvent`s (hit frames) and `AnimationFinished` don't depend on the
  tier. Graphs (`animation/graph`) evaluate on near and mid, and at the `simTick` rate on far and
  off.
- **Flat sampler** (`samplePose`): the same channel code, masks, additive layers and retarget
  corrections. It binds by joint index against a skeleton, not by entity, starts from the build's
  rest pose, and writes local TRS, then model-space rows, then `joint × inverseBind`. Morph and
  property channels and root motion play at near only. Below near, a character's morphs are its
  static weights, and the root channel is sampled in place (hordes move by nav).
- **Mid rate:** every frame above `mid.rates[0]` screen size, every 2nd above `rates[1]`, else
  every 4th, staggered. Poses step between samples; they aren't interpolated.
- **Far:** plays the two heaviest override layers, normalized, with their speeds and fade.
  Masked and additive layers are dropped.

### Pose sources (`@aethervtt/shard-render`)

- `DeformStore` gains **persistent pose ranges** before the per-frame region of `poses`, uploaded
  in dirty ranges. A mid character's range changes only when it's resampled. Its deform record
  word 4 points there, so **the vertex stage is unchanged for mid**. Words 9–10 point at the
  character's persistent morph block. The record's world sphere is the sampled model-space sphere
  moved by the root each frame.
- **Baked playback:** a far slot's word 5 has `BAKED_BIT`. Word 4 then points at a persistent
  3-vec4 header: two `(clip base, frames, start, speed)` and `(fps, fade start, fade duration,
  flags)`. A clip's frame position is `start + clock × speed`, in frames (so a paused layer holds
  any time, and `fps` is 1). B is the layer rising in a crossfade, so its share
  `(clock − fade start) / fade duration` only goes up. Bakes live in the persistent region of `poses` too, and `poses[0]` is a clock the CPU
  writes once a frame (rebased every 1024 s so f32 keeps its precision). `deform_vertex` computes
  each clip's frame from the clock, blends two adjacent frames and the two clips, then skins as
  usual. It's a branch on `BAKED_BIT`, with no new binding and no define. The header changes only
  when the layers change, so a far character is never sampled. `poses` is a `@data` array, so
  this works on the baseline tier as a data texture.
- **Far bounds.** A far slot's sphere is the build's baked bounds over every baked frame, moved
  by the root each frame. That and the instance transform are a far character's whole per-frame
  CPU cost. So culling, 0116's caster tests and occlusion all see a sphere that holds every
  pose.
- Far slots are skinned slots, so 0116 classifies them as dynamic casters with no extra tag.
- `prepare-deforms` skips slots whose source is persistent and unchanged.
- `SkinPose { source: 'joints' | 'pose' | 'baked', range: u32, morphs: u32 }` (render; not
  serialized) is what `characters` writes on a part. Without it a slot uses `joints`, as today.

### Movement tiers (`@aethervtt/shard-nav`)

```ts
NavTier { tier: 'crowd' | 'steer' | 'coarse' }   // absent: crowd (0037 behaviour)
NavAgent.flow: entity                             // follow a NavFlowField instead of a findPath
NavFlowField { goal: vec3, target: entity, filter: string, range: f32 = 300, nav: entity }
NavBudget += { crowd: 128, joins: 8, steerHz: 10, coarseHz: 2, flowMs: 1 }
```

- Tiers and flow fields are `navTiersPlugin` (`nav/tiers`), which an app adds when it moves
  hordes: in `navPlugin` they cost a grid-only game 11 KB of bundle (`export-maze-chase` went over
  its size budget). Without it, `NavTier` is ignored and `NavAgent.flow` falls back to `findPath`.
- `characters` writes `NavTier` from the sim tier: crowd within `simNear` (nearest `NavBudget.crowd`
  per navmesh), steer within `simMid`, coarse beyond. Games without `characters` set it
  themselves.
- **Crowd:** as today. Joining adds the agent at its position with its current velocity, at most
  `joins` a frame, and aims at `rec.legEnd` (0114). Leaving keeps the velocity.
- **Steer** hands the agent to nav's own mover through 0114's `setNavMover(world, e, 'external')`
  (`nav/steer`, after `nav/agents`). It has no crowd slot. It walks 0114's leg: the plan's corners
  up to `rec.legCount`, then `rec.legEnd`. For a flow agent, the field decides the corners instead.
  Every `1/steerHz` s, staggered: seek the next corner (arrive at the last), separation from crowd
  and steer agents in a spatial hash, then `moveAlongSurface` with the agent's **walk filter**
  (0114) from the last surface point, at the polygon's height. Every fixed step integrates the last
  velocity, which is cheap. A steer agent never enters a polygon its walk filter excludes. It
  stops while `blocked`, and walks on when 0114 sets it `moving` with a new `legEnd`.
- **Coarse:** the same at `coarseHz`, with no separation. When it can't stop within
  `stoppingDistance` of `legEnd`, it calls 0114's `navAgentAt`.
- Below crowd, the drive is the transform. A `CharacterController` gets physics'
  `CharacterSuspended` tag: it skips the move query and its capsule follows the Transform
  kinematically. So walk filters, not colliders, keep these agents out of shut doors.
- **Flow fields:** a Dijkstra over navmesh polygons from the goal, out to `range`, priced with the
  agent filter's **plan filter** (0114). Edge costs are distances times area costs, shut breach
  gates included at their breach cost; `exclude` states are skipped. Each polygon stores its next
  polygon and a cone of visibility toward the next turn of its shortest route (portal midpoints
  alone overpriced diagonal routes across the tile grid by up to 38%). An agent aims straight at
  that turn when it can see it, else at the nearest portal end shrunk by its radius. The polygon
  graph is snapshotted per tile into typed arrays, refreshed only for tiles that change. Builds are sliced at `flowMs` a frame, and agents follow the old field until the
  new one lands. A rebuild comes when the goal moves more than 2 m, or a tile or gate in range
  changes. An agent outside the field, or in a dead end, falls back to `findPath`. A flow agent
  in steer or coarse makes no `findPath` call.
- **Breaching on a flow route.** When a flow agent's next polygon belongs to a gate whose flags
  hold a state its filter breaches, its leg ends at that gate's entry portal (`rec.legEnd`, with
  the gate). 0114's breach step then claims a slot there and fires `NavGateBlocked`, in every
  movement tier. When the gate passes the filter, the agent's leg resumes along the field.

### Hordes past replication (`@aethervtt/shard-characters/net`)

A count and an area can't hand off: a real zombie arriving in range would appear somewhere its
proxy wasn't. Members are cheap enough to send one by one, at 4 bytes and a low rate:

```ts
HordeMember  { id: u32, look: u16 }                       // on zombies; saved in 0113's dormant entities
HordeCell    { grid: u8, x: i32, z: i32, y: f32, rev: u32, // server entity, one per occupied cell:
               ids: list(u32), looks: list(u16) }          //   membership, sent when it changes
HordeMembers { rev: u32, members: list(u32) }              // per member: x u8, z u8 (0.25 m), y i8,
                                                           //   heading 5 + activity 3 bits
```

- Net resends a whole component when any field changes, so membership and positions are two
  components. Both go through a binary codec (`replicate(def, { codec })`, new in net), not JSON.
- `look` indexes the game's looks (`characterLooks(world, [{ rig, build, parts, morphs }])`): a
  few outfits and builds that stand in for the real variety at far. `Character.look` uses the
  same index, so a replicated character root with a look gets its parts composed on the client
  (`characters/compose`); parts are never replicated, and a server spawns roots only.
- **Server** (`characters/hordes`, 2 Hz, cells staggered): live members are `HordeMember`
  entities in the partition's first grid. Dormant members come from `dormantEntities`, re-read
  only when a cell's delta rev changes. Cells within 1.25 × the far range of a player get a
  `HordeCell`. The payload doesn't depend on the peer, so it's encoded once.
- **Interest** (`hordeInterest()`, combined with `anyOf`): a cell is relevant to a peer when it
  lies within the peer's last level range and reaches past 0.8 × `replicate.range`. It's sent
  every 1 s within 1.5 × `replicate.range`, else every 2 s.
- **Client:** a pooled far-tier proxy per member, except members it has as live replicated
  entities (`HordeMember.id` matches). Proxies glide to each update's positions over the update
  interval, playing the activity's far clip (idle, walk, attack). When a real zombie arrives, it
  starts at its proxy's drawn position and converges on its replicated one over 0.5 s, and the
  proxy is released. When one leaves interest, its proxy resumes from its last position.
- A member stays listed in its old cell until its new cell lists it, so it's never missing; a
  cell that gains a new member refreshes at once rather than waiting for its slot.
- At 2,000 members past range: 8 KB of positions per full refresh. Moving hordes change
  membership at almost every send, so ids go out too: about 5.6 KB/s per peer.

### Shadows (0116)

- Near, mid and far cast through the shared `deform_vertex` as dynamic casters. A far shadow plays
  the baked pose, and a mid shadow steps at mid's sample rate.
- "Off" uses `casterRelevant` (above), so a character never goes off while its shadow can show.
- `far.shadows: false` on a rig sets `NotShadowCaster` on far parts. 0116's `minCasterTexels`
  already drops casters smaller than a texel.
- A pinned player's head, hair and headwear are separate parts, so 0116's `ViewVisibility` can
  hide them from the first-person camera. `far.merge` never applies to a pinned character.

### API sketch

```ts
import { CharacterTier, charactersPlugin, partsOf, spawnCharacter, TierSource } from '@aethervtt/shard-characters'
app.addPlugin(charactersPlugin({ maxNear: 16, maxMid: 160, serverRigs: false }))
world.add(camera, TierSource, { viewer: true }); world.add(player, TierSource, { player: true })
world.set(playerCharacter, CharacterTier, { pin: true })
const z = spawnCharacter(world, zombieRig, { build: 'heavy', parts, morphs, transform })
world.add(z, NavAgent, { flow: noiseField, filter: 'zombie' })
for (const [e, tier] of q) if (tier.simTick) think(e)             // game AI
// zombie.character.json
{ "skeleton": "characters/base/base.glb", "shapes": "characters/base/body.json",
  "clips": { "walk": "...", "idle": "...", "attack": "..." }, "bakeFps": 30,
  "builds": [{ "name": "heavy", "morphs": { "weight-max": 1 } }, { "name": "tall-arms", "morphs": { "arms-long": 1 } }],
  "near": { "screen": 0.15 }, "mid": { "screen": 0.02, "rates": [0.08, 0.04] },
  "far": { "screen": 0.002, "distance": 600, "shadows": true, "merge": ["body-*"],
           "clips": ["walk", "idle", "attack"], "pin": false },
  "parts": { "eyelashes": { "minTier": "near" }, "eyebrows": { "minTier": "mid" }, "eyes": { "minTier": "mid" } } }
```

`TierBudget` (resource): `maxNear 16`, `maxMid 160`, `joinsPerFrame 4`, `hysteresis 0.15`,
`dwell 0.3`, `ikFade 0.2`, `simNear 30`, `simMid 80`, `simEvery [1, 4, 15]`.

### Agent surface

- `characters.describe` returns counts per tier and sim tier, pinned characters, swaps this frame,
  joints sampled, rigs in use and pooled, bake bytes per build, and each system's ms. With an
  `entity`: its tiers, screen size, rate, build, parts, last swap and pose source. MCP:
  `characters_describe`.
- The `character-tiers` overlay marks each drawn character green (near), yellow (mid) or red
  (far).
- `nav.describe` agents gain `tier`. Flow fields list goal, polygons, build progress and agents.
- `net.describe` lists horde cells per peer (members, bytes).
- **Errors:** `characters/unknown-rig`, `characters/unknown-build`, `characters/skeleton-mismatch`,
  `characters/morph-moves-joints` (warn), `characters/merge-material` (merged parts' materials
  differ), `characters/root-motion` (warns once: dropped below near), and
  `nav/flow-unreachable`.

### Changes outside this spec's package, for 0114 and 0116

- **nav** (movement tiers only): `NavTier` and the steer and coarse mover (`steer.ts`, new), which
  call 0114's `setNavMover`, walk `rec.legCount` and `rec.legEnd`, and call `navAgentAt`. Also
  crowd joins capped at `joins` and seeded with the agent's velocity; `NavAgent.flow`, which skips
  `findPath` in `plan()` for external flow agents; `NavFlowField` (`flow.ts`, new); and the new
  `NavBudget` fields. The breach step, gates, filters and replan membership are only read.
- **physics:** the `CharacterSuspended` tag.
- **No manifest plugin.** Like `partition`, which its hordes need, `charactersPlugin()` is added in
  code: a manifest row would make `project` depend on `characters`, which depends on `partition`,
  whose tests depend on `project`. It doesn't need `animation`, which servers drop: players then
  only hold data.
- **render:** persistent pose and morph ranges, the clock and `SkinPose` in `DeformStore` and
  `prepare-deforms`, and the baked branch of `deform_vertex`. The instance store (0116's) is
  unchanged: far slots report their baked sphere through the deform record, like any skinned
  slot.

## Decisions

- **A new package, `characters`.** It joins animation, render, nav and net; none of those should
  know the others.
- **Characters are composed per instance, not per outfit.** A model per combination doesn't
  scale. Parts share the skeleton's inverse binds, so one pose and one bake serve them all.
- **Joint offsets come from a palette of builds.** A bake bakes joint positions, so continuous
  offsets would need a bake per character. Morphs alone are free per character on every tier.
- **Bone matrices baked, not vertices.** One bake serves every LOD level and part, it blends two
  clips with two lookups, and 53 joints are tiny next to vertex counts.
- **Baked playback is a branch, not a plugin or a define.** Skinning's WGSL is already core. A
  define would double every mesh pipeline (forward, prepass, shadow, G-buffer, motion vectors,
  picking), and the branch costs unbaked slots one bit test.
- **Bake at load from the flat sampler, not at import.** It takes milliseconds per build, and it
  matches mid exactly at frame times, retargeting included.
- **Merge the body at far.** Body regions exist so clothes can hide them, which doesn't matter at
  60 m. Nine slots per character would dominate a far horde's instance cost.
- **Mid writes into the existing pose buffer.** Records already point at poses, so mid needs no
  shader change; persistence alone makes reduced rates free between samples.
- **Pool rigs.** The joint entity count is bounded by `maxNear` plus the pinned characters,
  whatever the horde's size, and a horde rushing in spawns nothing.
- **Pin outside the caps.** A player's character must never lose its rig to a horde.
- **Select after propagation.** Off is decided with this frame's camera, so a fast turn never
  shows a missing character.
- **Time runs on every tier.** Gameplay that waits on a hit frame mustn't depend on the camera.
- **Screen size plus caps, as Mass.** Screen size covers FOV and first person, and caps hold the
  budget when a horde is close.
- **Steer below the crowd, as a 0114 external mover.** Detour's avoidance cost grows with the
  neighbours in range, and far agents need none. Breaching runs outside the crowd, so a mover
  needs only the leg.
- **Suspend by a tag, not a controller field.** Any change to `CharacterController` recreates
  its Rapier character; a tag moves the entity's table once per tier change, which hysteresis keeps
  rare.
- **A rig binds from rest, and draws a frame late.** Retargeting corrects against the pose a joint
  holds when it binds. The swap frame draws the flat pose instead, which is the same pose.
- **Walk filters keep movers out of shut doors.** Below the crowd the controller is suspended, so
  nothing physical would.
- **Flow fields over polygons, priced by the plan filter.** Gates, areas and filters already live
  on polygons, and a horde should choose between a long way round and a door the way one agent
  does.
- **Per-member horde cells, not counts and areas.** 4 bytes a member at 0.5 Hz is cheap, it
  covers dormant zombies, and it hands off without a jump.

## Acceptance criteria

The fixture is `horde(n, bands)`. Each character is Risen's `base.glb` (MakeHuman, game-engine
rig, 53 joints, CC0) with eyes, brows and lashes, a build from a palette of 4, and random free
morphs. It plays walk, idle and attack clips retargeted from CMU mocap (0034), on a flat navmesh,
each character walking a path. Tier counts are logged on every run.

- [ ] **500 walking.** 40 characters at 2–15 m, 160 at 15–60 m and 300 at 60–300 m, the camera
      moving along a fixed path: frames within `horde-walk` (1920×1080, laptop), and every slice
      within its share. No tier exceeds its cap.
- [ ] **2,000, mostly far.** 40 at 2–15 m, 160 at 15–60 m and 1,800 at 60–500 m: frames within
      `horde-far`. `characters/select` stays within its unit budget per character.
- [ ] **Nothing off screen samples.** With the camera turned away from half the fixture and no
      shadowed light, joints sampled equal 53 × the near and mid characters resampled that frame.
      Off and far add 0, and `animation/sample` binds no off character. After a 180° turn in one
      frame, every character now in view is drawn that frame. With a low sun, a character behind
      the camera whose shadow falls in view isn't off.
- [ ] **No pose jump.** A character walks from 2 m to 650 m and back, crossing every boundary
      both ways, with foot IK on a 15° slope near. `deformedPositions` (render testing: the CPU
      mirror of `deform_vertex`, checked against a GPU readback for each source) compares level-0
      vertices at the same animation time on either side of each swap. Near ↔ mid: within 0.1 mm.
      Mid ↔ far: within 0.5 px projected. With time running, no vertex moves farther across a
      swap frame than 1.5 × its largest move in the 10 frames before. Also passes with
      `SHARD_TIER=baseline`, and with a non-default build and free morphs.
- [ ] **Composed characters.** A character of 9 body parts, the face parts and two items on the
      skeleton has one pose range and one header. Its parts' records point at them. A part on
      another skeleton logs `characters/skeleton-mismatch`. At far it draws 1 merged body plus its
      items, and the merged body's vertices equal its parts' (same pose, same morphs). Two
      characters with different free morphs and the same build share one bake.
- [ ] **Pinned.** A pinned character stays near with 0 free near slots, off screen, at 300 m, and
      through a horde of 500 crossing the caps; the other near characters still number `maxNear`.
- [ ] **Joint entities follow near only.** With 16 near and none pinned, the joint entity count is
      the same for 100 and for 2,000 characters, at most (`maxNear` + 4) × 53.
      `core/transform-propagate` stays within its `horde-far` share.
- [ ] **Swaps are budgeted.** The camera dollies through the 500 fixture: no frame's swap work
      exceeds `characters/swap`, and no more than `joinsPerFrame` characters enter near in a
      frame.
- [ ] **1,000 agents on a server.** Headless (no render plugin) on 0112's town, with 4 players and
      1,000 agents, 200 of them a horde following one flow field to a noise. `nav/agents` plus
      `nav/steer` plus the `characters/*` systems stay within `characters/server-tick` (p95,
      60 Hz). Agents within `simNear` of a player are in the crowd, up to `NavBudget.crowd`, and
      no others are. Every agent stays within 0.1 m of a polygon its walk filter passes. No
      moving agent's speed drops below 50% across a join or a leave.
- [ ] **Flow fields.** A 300 m field on the town builds within `nav/flow-build`, sliced at
      `flowMs`. The 200 horde agents call `findPath` 0 times while in steer or coarse, and
      arrive. Locking a door on the route (excluded by their filter) rebuilds the field and
      reroutes them through another door.
- [ ] **A horde breaches in steer.** 30 zombies with 0114's breaching filter follow a flow field
      through a closed door of `breachHouse`, all in steer, 50 m from every player. No member's
      centre enters the gate's footprint. Every member gets `NavGateBlocked` in a distinct slot.
      When the door opens, they walk on with 0 `findPath` calls and all reach the room (one goal
      for 30: they arrive as a crowd around it).
- [ ] **A far horde shows.** Two peers (`run --net`): a live horde of 300 at 300 m from client A
      (simulated around client B) and a dormant horde of 200 in an unloaded cell at 400 m. Within
      2 s of joining, A draws 500 far proxies, each within 0.5 m plus 2 s of travel of its
      server position. Walking into range, A draws each zombie exactly once, and it moves at most
      0.5 m in any frame of the hand-off. Horde traffic past range stays under 6 KB/s per peer
      for 2,000 members. `characters/hordes` stays within budget.
- [ ] **Game reads tiers.** Over 60 frames, a far-sim character's `simTick` is true 4 times,
      and with 1,000 far-sim characters no frame flags more than ⌈1,000 / 15⌉ + 1.
- [ ] **Bake.** Baking the fixture's 3 clips for one build takes at most `characters/bake`.

## As built (in progress)

Built so far against `main` at `fba8dfc`, before 0114 and 0116 land. On the fixture (Risen's
`base.glb`, 12 parts, 53 joints, 14 morphs; CMU walk 1.1 s, idle 4.9 s, attack 1.4 s), measured
on an Apple M5 Max (not a named machine, 2026-11-13, other jobs running):

- **Swaps.** On the heavy build with a free morph, torso vertices move at most 1.3e-7 m across
  near ↔ mid (both ways), and 0.04 mm (at a baked frame) to 0.14 mm (between frames) across
  mid ↔ far, where the merged body's torso is compared.
- **Bakes.** 1.3–1.8 ms per build for the three clips; 559 KB per build (231 frames).
- **Selection.** 0.043 ms for 200 characters (median). A dolly through 100 characters swaps 141
  times; its worst frame of select plus sample is 0.58 ms, with at most 1 near entry a frame.
- **Flat sampler.** 67–71 ns a joint, about what the entity sampler costs here
  (`characters/sample` is proposed at 75 ns).
- **Render.** The pose and baked sources match the joints path on the GPU (images in view and in
  shadow, both tiers), and `deformedPositions` matches a GPU readback of the real `deform_vertex`
  within 1e-4 m for every source.

- **Hordes.** Two peers, a live horde of 300 at 300 m and a dormant one of 200 at 400 m: client A
  shows 500 proxies 0.47 s after joining, the worst at 3.38 m off its server position 2 s later
  (limit 3.5 m), and none moves more than 0.125 m in a frame of the walk-in. 300 hand-offs and 300
  resumes, with no member shown twice or missing on any frame. Traffic past range scaled to 2,000
  moving members: 5.58 KB/s. `characters/hordes`: 0.025 ms mean for 500 live and 1,500 dormant.

- **Movement tiers**, on 0114's movers: steer and coarse agents are `setNavMover` externals that
  walk 0114's legs (corners up to `legCount`, then `legEnd`) with the walk filter, stand while
  `blocked`, and call `navAgentAt` at a gate leg's end; 0114's `stepExternal` writes their status,
  and nav/steer a flow agent's. A flow agent checks up to 8 polygons ahead on its route for a gate
  its filter breaches, and opens a leg to that gate's face (`gateLeg` in 0114's `breach.ts`, the
  same entry a path that meets a gate at no corner gets). 30 zombies on one field, all in steer,
  50 m from any player, queue in 30 distinct slots, none enters the doorway, each gets
  `NavGateBlocked`, and once it opens all reach the room with 0 `findPath` calls. On 0112's
  town, 1,000 agents and 4 players: `nav/tiers` + `nav/flow` + `nav/agents` + `nav/steer` take
  0.88–1.18 ms p95 a tick; the crowd holds 128; flow agents below it call `findPath` 0 times;
  the worst agent is 0.024 m off the navmesh. A 300 m field (6,821 polygons) rebuilds in
  1.4–2.3 ms over 2–3 slices; its first build reads 1,972 tiles in 10–18 ms. Field costs match
  `findPath` lengths within 0.97–1.04. Across tier switches the slowest step is 52% of speed. The
  town tests are in `structure/src/tiers.test.ts` (nav can't import structure).
- **Scenarios** (`pnpm bench --scenario horde-walk|horde-far`, laptop budgets applied on this
  machine; GPU passes untimed, the adapter has no timestamps). On 0116 (a57f53f), horde-walk (16
  near, 160 mid, 230 far) runs at a CPU frame p95 of 5.05 ms and horde-far (16 near, 160 mid,
  1,730 far) at 7.53 ms, both within their 8 ms. Before 0116, horde-far took 10–12 ms. Five
  slices are over their proposed shares in each, and the shares were guesses: at p95 in
  horde-far, select takes 1.5 ms (0.16 proposed), characters/sample 1.18 ms (0.64), render
  3.4 ms (3.2), animation/sample 0.57 ms (0.32). Per frame at p50, before 0116: prepare-deforms 1.4–1.6 ms (most of
  it the 16 near characters' joints, recomputed per part), characters/sample 1.3–1.5 ms (mid
  resampling plus parts following roots), select 0.7–0.8 ms (with swaps as the view pans), nav
  1.2 ms, prepare-instances 0.6–0.7 ms. Several slices are over their proposed shares in both.
  Two render fixes came out of it: SkinPose records are cached (rewritten when their source,
  mesh, LOD, visibility or the store's layout changes; otherwise only the sphere moves), and
  instance uploads bridge gaps of up to 8 clean slots (scattered moving parts had made thousands
  of writes, 6 ms a frame).

- **Shadows (0116).** Selection asks `casterRelevant` for every viewer before putting a character
  off, with the sphere its slots draw with (the bake's at far). Under a low sun, a character 4 m
  behind the camera stays drawn; with the sun overhead it goes off. `far.shadows: false` puts
  `NotShadowCaster` on a character's far parts while it's far. Far slots are skinned, so 0116
  counts them as dynamic casters with no tag.

Not built yet: horde cells in `net.describe`. Next for the slices: share one joint-matrix pass
among a near character's parts, and make selection cheaper per character.

## Open questions

- **Occlusion.** Should 0116's `occluded()` slow animation? Proposed: occluded mid characters skip
  resampling but keep their tier. A character drawn the frame it emerges then shows a pose at most
  a few frames old, not a missing body.
- **Attachments below near.** Proposed: mid places attached entities from the flat pose at its
  rate, and far hides them. Drawing them rigidly skinned to the baked hand joint can follow if a
  game needs held items at range.
- **Interpolating mid poses.** Proposed: no (see Mid rate). Revisit if the 15 Hz step shows at 1440p.
- **Proxies on unloaded ground.** Proxies take `y` from the server. A far cell whose terrain differs
  (a hill) could float them. Proposed: accept; HLOD (0073) terrain matches the server's.
- **Skin tint per character.** Zombies are "the same people, worn" (Risen's ADR 0003). A material
  per character splits batches. Proposed: later, as a per-instance tint in the instance record.
