# 0117 — Ragdolls and physical animation: hit reactions at crowd scale

- **Status:** accepted (2026-11-14). Implemented once its criteria pass in CI.
- **Packages:** `@aethervtt/shard-ragdoll` (new), `@aethervtt/shard-physics`,
  `@aethervtt/shard-characters`, `@aethervtt/shard-animation`, `@aethervtt/shard-cli`
- **Depends on:** 0028, 0029, 0032, 0034, 0053, 0087, 0088, 0114, 0115

## Context

Characters should react physically to being shot or struck while they keep doing what they were
doing. The case driving this is a zombie prototype where a horde chases the player, but nothing
here is specific to zombies: it's any skinned character in any game. A round to the left shoulder
should twist the shoulder, neck and head away while the legs keep walking, then the body pulls
back into its stride. A shotgun blast or a heavy swing should knock the character flat, and it
should get up again (or not, if it's dead). Canned hit clips can't do this: they don't know where
the hit landed or from which side, and every character flinches the same way.

The usual answer is a **ragdoll** (one rigid body per major bone, joined with limits) driven by
**physical animation**. Unreal does it with a Physics Asset, the Physical Animation Component,
and a physics blend weight per bone. While the drives are strong, each body follows the animated
pose. A hit lowers the drives and raises the blend weight on the bones near the impact, so physics
shows for a moment, then the drives win back. A full ragdoll is the same setup with every drive at
zero.

Shard has bodies, joints (`Joint`, with velocity motors on revolute and prismatic only), skeletal
animation, IK with a blend weight, and since 0115, hordes whose characters mostly have no joint
entities at all. VISION lists ragdolls under "Later". A ragdoll costs bodies, joints and a rig,
so it has to fit 0115's tiers: hundreds of characters, only a few of them reacting at any moment.

## Goals

- A **ragdoll asset** per skeleton: bodies, shapes, joints with swing and twist limits, mass.
  Generated from a skinned model by `shard ragdoll gen`, then edited as data.
- **Partial reactions:** an impulse at a bone makes nearby bones react physically while the rest of
  the body keeps animating, then blends back, with no pop on either side.
- **Knockdowns:** a strong enough hit, a launch (a car), or enough hits close together makes the
  ragdoll full. It lands in a resting posture the server chose, then gets up, by itself or under
  the game's control.
- **Deaths:** a full ragdoll that never gets up. Once it settles it freezes into a posed corpse that
  costs nothing per frame on any tier.
- **Zero cost when nobody is hit.** No bodies, joints or per-frame work for characters that aren't
  reacting, so a horde of 2,000 pays nothing.
- **Bounded cost under fire:** a cap on simulated ragdolls. Hits beyond it, or on characters too
  small on screen, fall back to authored hit clips.
- **Bone hit tests** on every tier and on a headless server: which bone a ray hits, for headshots
  and for where the impulse goes.
- **Multiplayer:** the server decides reactions, the resting posture, and where a downed character
  gets up. Clients simulate the ragdolls as cosmetics.
- **Any root, not only Shard characters:** a plain replicated entity whose model exists only on
  clients can take hits and react. Games with their own animation motor can own clip choice, the
  get-up and root travel, and use only the physics.

## Non-goals

- Balance-driven stepping (a character catching itself by stepping, as Euphoria does), stumbling
  with the root, and learned controllers. A partial reaction never moves the root.
- Dismemberment. The asset leaves room for it (a joint can break), but hiding mesh parts isn't
  designed here.
- 2D ragdolls, cloth, soft bodies, and hair or jiggle physics.
- Damage, health, and weapon ballistics. The hit impulse is a gameplay value chosen by the game,
  not a bullet's real momentum (a 9 mm round carries about 3 N·s).
- Simulating ragdolls on the server.

## Design

### The ragdoll asset (`*.ragdoll.json`)

The asset describes bodies by joint name, so one asset serves any model on that skeleton. Any root
takes `Ragdoll { asset }`: a `Character` root (0115), a plain skinned model, or a plain replicated
entity whose model exists only on clients (below).

- **Bodies:** a subset of joints, typically 14 for a humanoid: pelvis, two spine segments, head
  (with the neck), upper and lower arms (hands follow the forearm), thighs, calves and feet. Each
  has a shape (`capsule`, `box` or `sphere`) in the joint's rest-local space and a share of total
  mass. A joint without a body follows its nearest ancestor that has one; fingers keep their
  animation.
- **Joints:** each body except the root is jointed to its parent body at the child joint's
  origin. Its kind is `spherical` (swing `[y, z]` half-angles and twist `[min, max]` in radians)
  or `revolute` (knees and elbows: a hinge axis and flexion limits). Spherical joints become
  physics `spherical` joints with frames and per-axis limits; revolute ones become physics `hinge`
  joints (two angular axes locked, not just limited). Contacts between jointed bodies are off.
- **Partial settings per body:** `maxWeight` (legs 0.4 by default, so a leg hit flinches without
  breaking the walk) and `stagger`, a factor on how much a hit there counts toward a knockdown
  (legs 2, head 1.5).
- **Profiles:** drive settings by name (`default`, `limp`, `stiff`): `stiffness` (1/s: an error
  closes over about 1/stiffness seconds), `damping` (a ratio: 1 settles without overshoot, below
  rings, above is sluggish; the settle rate is `4 × stiffness × damping²`), and `world` (0 to 1:
  how much of the drive pulls toward the animated *world* pose rather than the joint-local one).
  Default 30, 1, 0.15.
- **Zones:** each body names a zone (`head`, `body`, `arm_l`, `arm_r`, `leg_l`, `leg_r` from
  `gen`; any names the game likes). Hit tests report the bone and its zone, and clip roles use
  zones.
- **Rests:** the postures a downed character lands in. Each names its lying `pose` clip, its
  `getUp` clip, which hit direction leads to it (`from: front | back | side`), and two things
  `shard ragdoll gen --clips` extracts so a server needs no clips: the body poses of the lying
  pose's first frame (for hit tests and the fall steer), and the get-up's root `travel` curve (11
  samples of `[x, z]` in its start frame). A humanoid has `back`, `front`, and optionally `side`.
- **Clip roles:** a table from role to clip name, resolved against the character's clips:
  `hit.<light|heavy|moving>.<zone>` and `death[.moving].<zone>`, each falling back to the role
  without the zone. An entry can be a list (picked by seed) and says `blend: additive | override`.
  Shard's additive layers already add a clip's change since its first frame, so a full-body hit
  clip plays as additive as-is. One-shots that travel carry an extracted `travel` curve, as rests
  do.
- **Builds:** a build (0115) moves joints, so capsule lengths scale by each bone's length ratio
  against the asset's rest pose. The ratios are cached per build.

`shard ragdoll gen <model or rig> [--bodies humanoid|all]` writes the asset. Each body's capsule
fits the vertices weighted to its joints (weight ≥ 0.5) along the bone. Limits come from a
humanoid table by joint-name pattern, falling back to a 45° cone and ±30° twist. Masses follow
standard segment fractions (Dempster's), scaled to `mass` (default 70 kg). `shard validate`
checks the asset against its skeleton.

### Reaction state (`reactionsPlugin`, headless-safe)

Reactions are game logic with no physics, so the server and single-player run the same code.

```ts
Reaction { state: 'none' | 'partial' | 'down' | 'rested' | 'getting-up' | 'dead', since: f64,
           stagger: f32, bone: u8, rest: u8, role: u8, impulse: vec3, launch: bool, seq: u16 }
```

`Reaction` sits on the entity with `Ragdoll`: the replicated root. Game AI reads it there.

- `hit(world, root, { point?, impulse?, launch?, bone?, kind?, rest? })` registers a hit. `kind` is
  `auto` (the default), `partial`, `knockdown` or `death`. Without `bone`, the hit test (below)
  finds it.
- **Launch** (a car, an explosion): `launch: vec3` is a velocity given to every body at
  activation, on top of the root's, instead of an impulse at one bone. It always means a full
  ragdoll: a knockdown, or a death with `kind: 'death'`.
- **Role:** the hit picks a clip role from its zone, its strength (`heavy` past `heavyImpulse`),
  and whether the root was moving (`moving` past `movingSpeed`). It's stored in `role` and
  replicated, so every client plays the same clip.
- **Stagger:** each hit adds `|impulse| / (mass × knockdownSpeed) × body.stagger`, and stagger
  decays at `staggerDecay` per second. When it reaches 1, an `auto` hit becomes a knockdown. So
  one 175 N·s hit fells a 70 kg character at `knockdownSpeed` 2.5 m/s, and five 40 N·s hits within a
  second do too, but the same five hits three seconds apart don't.
- **Which rest** is decided here, at the knockdown, not from where the ragdoll lands (only clients
  simulate, and they'd disagree with each other and with the server, on the clip and on how long
  it runs). The hit's horizontal direction against the root's facing picks the rest whose `from`
  matches: hit from the front lands on its back, from behind on its front, from the side on its
  side if the asset has one. `hit({ rest })` overrides it.
- **Where it lands:** the root slides along the navmesh (`navRaycast`: it stops at a wall) in the horizontal
  direction of the velocity change `Δv` (`|J| / mass`, or the launch), by
  `min(Δv² / (2 × groundDecel), maxSlide)`. A 175 N·s hit on 70 kg slides 0.5 m; a car's 8 m/s
  launch, 5.3 m. It's deterministic, so server and clients agree. The root moves there over the
  fall (eased out, starting once the ragdoll has taken over), never in one step: a jump of the root
  showed as the body teleporting for the frames before the physics blended in. An app that
  simulates ragdolls with no net role skips the slide: when the body rests, its root moves under
  the ragdoll's pelvis, turned so the rest's lying pose lies the way the body does, and the rest
  blend settles in place.
- **Down** lasts `downTime` (2 s), then **rested** (lying in its rest's pose at the root). While
  down, rested or dead, the agent's nav mover is set to `external` with zero velocity (0114's
  `setNavMover`), and its controller gets `CharacterSuspended`. Both are restored when it stands.
- **Who drives** (`Ragdoll.drive`):
  - `auto`: after `restTime` (default 0) the root plays the rest's `getUp`, moving along its
    `travel` curve, as `getting-up`, then `none`. Role clips play as hits come in, and one-shots
    that travel move the root along their curve.
  - `game`: the reaction stops at `rested` and the game takes over. It plays the rest's lying
    pose, idles and get-up through its own motor, moves its root, and calls `stand(world, root)`
    when it's up. Role clips aren't played either; the game reads `role` and plays its own. Risen's
    server motor already carries the body along each get-up's travel curve, so it runs in `game`
    mode.
- `death` (or a knockdown upgraded by the game while down) sets `dead`: no rest, no get-up.
- **Events:** `ReactionStarted { entity, kind, bone, role }`, `KnockedDown { rest }`, `Rested`,
  `GotUp`, `CorpseSettled`.
- **Replication:** `Reaction` replicates through a binary codec (`replicate(def, { codec })`,
  0115): state, bone, rest, role, impulse or launch as three f16 with a flag bit, `seq` and the
  start tick. That's 16 bytes, sent when `seq` or the state changes. A client starts the ragdoll
  from the replicated hit.

### Bone hit tests

`hitTest(world, root, ray, out)` tests the ray against the asset's shapes, posed at the root's
current pose. It returns the bone, zone, point, normal and distance. The pose comes from the first
of these that exists:

1. **A Shard character** at the root or under it (`ChildOf`), by tier, as below.
2. **The game's pose source:** `ragdollPoseSource(world, (root, time, out) => boolean)`, called
   on a hit only. A game with clips on the server samples them; one without returns a rest's
   extracted pose (`restPose(asset, rest, out)`) for a lying character, or `false`.
3. **The asset's rest pose** at the root: standing, in bind pose. Good enough for a server that
   has no clips and a character on its feet.

- **Pose source by tier:** near reads joint `GlobalTransform`s. Mid reads its last flat pose
  (0115). Far, off, and a server with no renderer sample the pose on demand with the flat sampler
  (53 joints, about 4 µs). So headshots don't depend on the camera, and the server agrees with
  clients.
- **Lag compensation (0088):** `hitTest` takes a `time` offset. The on-demand sample uses the
  layer times at that tick, and the root comes from 0088's rewound transforms.
- **Broad phase:** the ray first hits the character's capsule in Rapier. `castHit(world, ray)` runs
  `raycastAll`, refines every character capsule it passes, and returns the first bone or world
  hit. A ray that grazes a capsule but misses every limb continues. A root with no collider gets a
  kinematic sensor capsule sized from the asset (lying, while rested). While a ragdoll is simulated, its bodies
  are hit directly and its capsule is skipped.

### Simulation (`ragdollPlugin`, client)

**Finding the skeleton.** On a client, the ragdoll drives the skinned skeleton at the root or the
first one under it (`ChildOf`): Risen's client spawns its `Character` as a child of the replicated
zombie. None found logs `ragdoll/no-skeleton` once and the reaction runs without physics.

**Activation.** When a reaction starts on a client, the character claims a ragdoll slot:

- Bodies come from a pool: 14 entities with `RigidBody`, `Mass`, `Joint` and a child `Collider`,
  kept out of Rapier with physics' new `PhysicsDisabled` tag while pooled (range parking leaves
  them alone). Activation places them at the joints' current world poses and removes the tag, with
  no create or destroy. Pooled bodies get 12 extra solver iterations (`RigidBody.solverIterations`,
  new): at Rapier's default 4, joint chains end up to 100° past their limits.
- **No pop:** on the activation frame the blended pose equals the animated one, because every
  weight starts at 0 and rises over `blendIn` (0.05 s).
- **Momentum:** each body's initial velocity is its finite difference between the pose this frame
  and one sampled at `t − 1/60` with the flat sampler, plus the root's velocity: its controller's
  or nav agent's, else its move over the hit frame (Transform now against last frame's
  GlobalTransform), for roots a game moves by Transform. A character killed at a run falls
  forward.
- The hit impulse spreads over the moving bodies by mass × `falloff`^distance from the hit body
  (`impulseShares`): a shoulder hit turns the chest too, and a hit on a 1 kg foot never sends it
  off at hundreds of m/s. A launch instead adds its velocity to every body, its horizontal part
  falling from all of it at the feet to 45% at the head, so the body pitches over a bumper instead
  of flying off as a plank.
- **Clips with physics:** a hit's role clip (in `auto`, or the one the game plays in `game`) is the
  animation the drives follow. At near with a slot the clip and the physics show together, as
  Unreal blends a hit reaction with physical animation. Without a slot, the clip alone shows.

**Partial.** The pelvis and the legs are `kinematic-position` and follow the animated pose, so
the walk goes on, a hit leg included: a simulated leg under a walking body swung against the walk.
A hit on an anchored body (a leg, the pelvis) centres the reaction on the root body's first moving
child instead, so the torso flinches above it; leg hits still count double toward a knockdown.
Other bodies are dynamic, and carry no weight (gravity sagged a weakened head forward as a hit
faded: a nod back and forth). Each gets a weight from its graph distance `d` to the reacting
body: `w = min(maxWeight, falloff^d)`, with `falloff` 0.6. A hit on the upper arm gives the arm 1,
the chest and forearm 0.6, and the head and other arm 0.36. The drive (stiffness and settle rate)
drops to `1 − √w × hitDrop` (`hitDrop` 0.9). Over `recover` (0.85 s) the blend carries the way
back: its weight, `min(1, 2w)`, holds for the first fifth and then eases to 0, so the body whips
away fast and comes back slow. The drives stay soft until the last 40% and only then return:
pulled back hard while still shown, the chain swung past the animation the other way. Then the
bodies are set aside and the slot is released.

**Full** (down or dead): every body is dynamic, every drive is 0, and every weight is 1. The
pelvis carries the pose's translation, so the body falls away from the root. While down, the pelvis
gets a weak world torque (`steer`, rising over `downTime`) toward the chosen rest's pelvis
orientation. It settles a borderline roll the way the server predicted, without a visible flip.

**Drives** run in `FixedUpdate` before `PhysicsSystems` (`ragdoll/drive`). For each dynamic body
they compute the rotation error to its target: the animated joint-local rotation, blended toward
the animated world rotation by the profile's `world`. They set the body's angular velocity to its
reference (its parent's, plus the animation's own turn against the parent, fed forward from frame
to frame) plus its deviation from that reference, which settles at `4 × stiffness × damping²`
(scaled by the hit's drop) while `error × stiffness` pulls it back. Fed forward, a weakened drive
still follows the walk in full; only the hit's deviation is slow. A velocity drive is exactly
mass-independent and stable at any stiffness; it gives the parent no reaction, which only matters
to a body nothing anchors (full ragdolls have no drives).
Targets are the animated pose captured after `animation/sample` on the previous frame, which is
one frame of lag.

**Blend** (`ragdoll/blend`, PostUpdate after `animation/sample`, before `TransformSystems`): for
each bone with a body, the physical local rotation is its body's rotation relative to its parent
body's. The joint's local rotation becomes `slerp(animated, physical, w)`. Translations stay
animated (bone lengths hold) except the pelvis's at full. Bodies are read at the pose interpolated
between their last two steps by `FixedTime.alpha`. The ragdoll keeps those two poses itself, so
this doesn't depend on `PhysicsConfig.interpolate`. IK (0034) runs after, on top, and its weights
fade to 0 over `ikFade` while full.

**Rest.** When the state turns `rested`, the ragdoll pose is snapshotted and every weight eases
from 1 to 0 over `restBlend` (0.5 s), toward whatever the animation now plays at the root: the
rest's lying pose (`auto` plays it; in `game` the game does). That's Unreal's pose snapshot blend.
The ragdoll is steered toward that pose and the root slid to where the server put it, so the blend
closes a small gap. Every client ends in the same lying pose at the same place, so the get-up that
follows (from the authored lying pose, travelling or not) matches everywhere. If the ragdoll hasn't
settled by `downTime`, it blends from wherever it is. A get-up never needs bodies.

**Corpses.** A dead ragdoll whose bodies all sleep, or that has been down `corpseAfter` seconds,
**freezes**. Its final joint poses go into a persistent pose range (0115's mid source), its parts'
`SkinPose` points there with `frozen` set, and the bodies and rig go back to their pools. Tier
selection still picks a visible tier and LOD level, but every visible tier draws the frozen range.
Far draws it too instead of a bake, and the merged far body uses the same range. A frozen corpse
is never sampled and has no colliders. `RagdollBudget.maxCorpses` evicts the oldest corpse with a
`CorpseEvicted` event; despawning it is the game's call.

**Collisions.** Ragdoll bodies collide with static geometry and with each other. Whether they meet
character capsules is `RagdollBudget.blockCharacters`. Off (the default), capsules ignore them (a
collision group), so the fallen never block a crowd and live characters never kick them. On,
bodies and capsules collide, for games where stepping over a body should cost something. A
character's own capsule never touches its bodies either way.

### Tiers and hordes (0115)

- A reacting character is **claimed** near (`CharacterTier.claim`, written by the ragdoll). It
  needs a rig, so claims work like pins. They don't count toward `maxNear`, and the rig pool grows
  by `RagdollBudget.maxActive`.
- **Choosing who simulates.** A hit claims a slot when the character's screen size is at least
  `promoteScreen` and a slot is free. When none is free, the lowest-ranked active ragdoll gives one
  up (rank: screen size, then recency):
  - A partial one blends out over 0.15 s.
  - A dead one freezes early.
  - A downed one freezes and rests on schedule from its frozen pose, since the rest blend
    doesn't need bodies.
- **Clips without physics.** A hit that gets no slot, or one on a character below
  `promoteScreen`, shows its role clip alone. A knockdown without a slot plays its `death` or
  heavy role clip, then the rest's pose and get-up. Override clips go in the far bake list, so a
  character sniped at 300 m still falls and gets up. Far drops additive layers, so a light hit
  there shows nothing. The state machine is the same either way.
- A mid character that claims a slot swaps to near with 0115's swap. Its rig draws a frame late, so
  the ragdoll activates on the next frame from the bound rig, which is still within `blendIn`.
- On a server there are no claims: `reactionsPlugin` runs and `ragdollPlugin` isn't added.

### API sketch

```ts
import { castHit, hit, ragdollPlugin, reactionsPlugin, Reaction } from '@aethervtt/shard-ragdoll'
app.addPlugin(reactionsPlugin())                                   // server and client
app.addPlugin(ragdollPlugin({ maxActive: 24, maxCorpses: 200 }))   // client only

world.add(zombie, Ragdoll, { asset: 'characters/humanoid.ragdoll.json', drive: 'game' })
const h = castHit(world, ray, { maxDistance: 80 })                 // bone-accurate
if (h.root) {
  hit(world, h.root, { point: h.point, bone: h.bone,
    impulse: scale(ray.dir, h.zone === 'head' ? 60 : 30),
    kind: health <= 0 ? 'death' : 'auto' })
}
hit(world, zombie, { launch: [carVel[0] * 0.8, 3, carVel[2] * 0.8] })  // run over
for (const [e, r] of q) if (r.state === 'rested') playGetUp(e, r.rest) // drive: 'game'

// humanoid.ragdoll.json (excerpt)
{ "skeleton": "characters/base/base.glb", "mass": 70,
  "bodies": {
    "pelvis":     { "shape": { "box": [0.32, 0.18, 0.2] }, "mass": 0.142 },
    "upperarm_l": { "shape": { "capsule": { "radius": 0.055, "from": [0,0,0], "to": [0,0.28,0] } },
                    "mass": 0.028, "joint": { "spherical": { "swing": [1.4, 1.2], "twist": [-0.8, 0.8] } } },
    "calf_l":     { "...": "...", "joint": { "revolute": { "axis": [1,0,0], "limits": [0, 2.4] } },
                    "zone": "leg_l", "partial": { "maxWeight": 0.4, "stagger": 2 } } },
  "profiles": { "default": { "stiffness": 30, "damping": 20, "world": 0.15 } },
  "rests": {
    "lie-back":  { "from": "front", "pose": "lie_back",  "getUp": "getup_back",  "travel": [[0,0], "…"] },
    "lie-front": { "from": "back",  "pose": "lie_front", "getUp": "getup_front", "travel": [[0,0], "…"] },
    "lie-side":  { "from": "side",  "pose": "lie_side",  "getUp": "getup_side",  "travel": [[0,0], "…"] } },
  "clips": { "hit.light": { "clip": ["hit_light_body"], "blend": "additive" },
             "hit.heavy.arm_l": { "clip": "hit_heavy_arm_l", "blend": "override" },
             "hit.moving.head": { "clip": "hit_walk_head", "blend": "override", "travel": ["…"] },
             "death.head": { "clip": "death_head", "blend": "override" } },
  "reactions": { "falloff": 0.6, "hitDrop": 0.85, "recover": 0.4, "knockdownSpeed": 2.5,
                 "staggerDecay": 0.8, "heavyImpulse": 60, "movingSpeed": 0.5, "downTime": 2,
                 "groundDecel": 6, "maxSlide": 6 } }
```

`RagdollBudget` (resource): `maxActive 24`, `maxCorpses 200`, `promoteScreen 0.05`,
`blendIn 0.05`, `restBlend 0.5`, `ikFade 0.15`, `corpseAfter 6`, `blockCharacters false`.

### Agent surface

- `ragdoll.describe`: active ragdolls (state, weights and strengths per body, slot rank), pooled
  bodies, corpses, clip fallbacks this second, and each system's ms. With an `entity`: its
  `Reaction`, stagger, and last hit. MCP: `ragdoll_describe`.
- `ragdoll.hit` (protocol and MCP) applies a hit, so an agent can try reactions in a running game.
- The `ragdoll` overlay draws bodies (colored by weight), joint limit cones and the last hit ray.
- `shard ragdoll gen [--clips]` (with `--clips`, it extracts rest poses and travel curves) and
  `shard ragdoll check <asset> [--impulses 100]` (random hits headless, reporting limit violations,
  NaNs, and settled poses against their rest), both with `--json`.
- **Errors:** `ragdoll/unknown-joint`, `ragdoll/skeleton-mismatch`, `ragdoll/bad-limit`,
  `ragdoll/no-asset` (a hit on a root without one), `ragdoll/no-skeleton` (warn: a client root
  with nothing skinned to drive), `ragdoll/missing-clip` (warn: a role, rest or get-up clip the
  character lacks), `ragdoll/stale-extract` (a rest's extracted pose or travel no longer matches
  its clip).

### Changes outside this package

- **physics:** `Joint` gains `frame`, `otherFrame`, `twist`, `swingY`, `swingZ` (per-axis ranges,
  through Rapier's raw joint set, whose JS wrapper limits unit joints only) and `contacts`, and a
  `hinge` kind. `RigidBody.solverIterations`, the `PhysicsDisabled` tag, `PhysicsWorld.setKind`
  (dynamic ↔ kinematic without a rebuild), and `PhysicsConfig.characterIgnores` (layers capsules
  pass through: ragdoll bodies are in layer 1 << 15).
- **characters:** `CharacterTier.claim` and `frozen`, `freezeCharacter` / `thawCharacter`
  (a frozen pose in the persistent pose range, drawn on every tier, merged far body included), and
  a `./testing` export of the fixture app.
- **animation:** nothing new. The flat sampler and layers are used as they are.

## Decisions

- **A new package with two plugins.** Reactions run on servers that have no Rapier ragdolls and
  no animation plugin; simulation needs physics, animation and characters. A game that never
  ragdolls adds neither.
- **Hit tests are ours, not Rapier bodies per bone.** Kinematic hitboxes on 2,000 characters would put
  28,000 bodies in Rapier. One capsule per character, refined against the posed shapes on a hit, costs
  nothing between shots.
- **Drives are velocity drives we compute, not Rapier motors.** Rapier 0.20's spherical joints
  take per-axis angle targets, which don't compose for large rotations. Setting the angular velocity
  from our side works the same in the deterministic variant and in a headless test, and is stable at
  any stiffness.
- **Limits are Rapier's, through its raw joint set.** `jointSetLimits` takes any angular axis on
  any joint, so spherical joints get real swing and twist limits; hinges lock two axes. Rapier
  measures the other body's frame against the joint body's, so the binding negates limits.
- **Partial keeps the pelvis and legs kinematic.** That's what lets the walk go on, and the root
  never moves, so nav, crowd and breaching (0114) don't see a partial hit.
- **The server decides the rest and where a character lands.** The ragdoll is cosmetic and differs
  between clients, and get-ups differ in length (Risen's run 6.1 to 7.8 s), so a client-picked
  get-up would disagree on when it stands. A deterministic slide and rest give one answer, and the
  steer and rest blend close the gap.
- **Any root, with a pose source.** Risen's server zombie is a plain replicated entity, and its rig
  exists only on clients. Asking a Shard character, then the game, then the rest pose covers that
  without forcing a skeleton on the server, as 0115 lets games without characters set `NavTier`.
- **Games can own the get-up and root travel.** Risen's motor already plays rest idles and get-ups
  that carry the body 0.4 to 0.8 m along the clip's path. `drive: 'game'` keeps the physics and
  hands over at the rest; `auto` does the same steps for games with no motor.
- **Clip roles over fixed names.** Games name clips their own way (Risen: `hit_heavy_arm_l`,
  `death_head`). A table by role and zone maps them, and Shard's first-frame additive blending
  makes any full-body hit clip usable as an additive one.
- **A launch is velocity on every body.** A car hit moves the whole body at once; an impulse at one
  bone would spin a limb off first.
- **Ragdolls don't match across clients.** Each starts from the pose its client drew, the slot cap
  depends on each camera, pool order and neighbours differ, and JS math isn't bit-identical across
  engines; a tumbling ragdoll magnifies all of it. Only the logical root is shared, so gameplay
  (loot, interaction, get-up) reads the root, never the bodies. "Deterministic" below means one
  machine replaying a run.
- **Pool bodies and set them aside.** Activation under fire is a few writes, never Rapier creates.
  `PhysicsParked` couldn't do it: range parking unparks everything when there's no grid.
- **Extra solver iterations on ragdoll bodies, not the world.** Rapier raises them per island, so
  only ragdolls pay for limits that hold.
- **Initial velocity from the animation.** Without it, a running character stops dead in the air when it
  dies, which reads worse than any limit problem.
- **Freeze corpses into pose ranges.** 0115's persistent ranges already draw a static pose on every
  tier for free, so a street of 200 corpses costs culling only.
- **Claims, not pins.** A ragdoll's rig need ends on its own and is capped separately, so a fight
  can't starve the near tier or the player.
- **Clips without physics run the same state machine.** Gameplay (down, rested, dead) can't depend
  on whether a slot was free or where the camera is.
- **One frame of target lag.** Physics steps before animation samples. Sampling ahead would mean
  sampling twice a frame, and 16 ms of lag doesn't show under a lowered drive.
- **Capsules ignore ragdoll bodies by default.** Bodies pushing live capsules feed back into nav
  and the crowd, and cost contacts in exactly the fights that are already expensive. Games that
  want bodies to block turn on `blockCharacters`.

## Acceptance criteria

The fixture is 0115's `horde(n, bands)` with `shard ragdoll gen` run on `base.glb` (14 bodies),
Risen's reaction clips (hits, deaths, rests and get-ups), and the deterministic Rapier variant.

- [ ] **Generation.** Each generated capsule contains at least 95% of the vertices weighted ≥ 0.5 to
      its joints in the rest pose. `shard ragdoll check --impulses 100` (up to 500 N·s, random bones
      and directions) reports no NaN, no joint more than 5° past a limit once settled, and no body
      more than 2 cm below the ground.
- [ ] **Idle costs nothing.** In `horde-far` with both plugins and no hits, the ragdoll systems take
      at most `ragdoll/idle` together, and no ragdoll body is in Rapier.
- [ ] **Partial while walking.** A character walks at 1.4 m/s and takes 40 N·s at `upperarm_l` from the
      front. Within 0.15 s the chest and head turn away by at least 15°. The pelvis and feet stay
      within 1 mm of the animated pose, and the root's speed stays within 1%. By `recover` + 0.1 s
      every bone is within 0.5° of the animated pose and the bodies are parked.
- [ ] **No pop.** On the activation frame and the release frame, skinned vertices (`deformedPositions`)
      are within 0.1 mm of the animated pose. Across the rest blend and the get-up, no vertex moves farther in a frame
      than 1.5 × its largest move in the 10 frames before (0115's measure).
- [ ] **Knockdown.** The same hit at 175 N·s fells it: `KnockedDown` fires, the pelvis drops below
      0.4 m within 1.5 s, and its nav agent stops. Five 40 N·s hits within 1 s fell it. The same five
      hits 3 s apart don't.
- [ ] **Momentum.** Killed at 4 m/s, the pelvis body's initial velocity is within 10% of the root's
      plus the animation's pelvis velocity.
- [ ] **Rest and get-up.** Hit from the front it rests `lie-back`, from behind `lie-front`, from the
      side `lie-side`, on server and clients alike. Over 100 random knockdowns, the settled pelvis is
      within 45° of its rest's in at least 95%, and the rest blend never moves the pelvis more than
      0.3 m. In `auto`, the get-up's root follows its travel curve within 2 cm and ends standing
      within 0.05 m of the curve's end.
- [ ] **Game-driven.** With `drive: 'game'`, the reaction stops at `rested`, plays no clip, and
      moves no root, until `stand()`. The game's lying pose takes over within `restBlend`.
- [ ] **Plain roots.** A replicated root with `Ragdoll` and no skeleton on the server: `castHit` on
      the server finds the head through the rest pose (standing) and a `restPose` source (lying).
      On a client whose `Character` is a child of that root, the same hit activates the ragdoll.
- [ ] **Launch.** A launch of 8 m/s at a walking character makes a full ragdoll whose bodies all start
      within 10% of the root's velocity plus the launch. The server root slides
      `min(Δv² / (2 × groundDecel), maxSlide)` along the navmesh, within 1 cm.
- [ ] **Roles.** A light head hit plays `hit.light`'s clip as additive while the walk continues; a
      heavy left-arm hit while moving plays `hit.moving.arm_l` if mapped, else `hit.moving`. The
      replicated `role` makes every client play the same clip.
- [ ] **Corpses.** A dead ragdoll freezes within `corpseAfter` s. Then it has 0 bodies, the rig pool is
      back to its size, and vertices across near, mid and far match within 0.1 mm. 200 frozen
      corpses add 0 joints sampled, and `characters/select` stays within its `horde-far` share.
- [ ] **Under fire.** 40 characters are hit in one frame with `maxActive` 24. The 24 largest on screen
      simulate and the rest play clips. No frame exceeds the `ragdoll-fight` budget, and no more than
      `joinsPerFrame` characters swap to near in a frame.
- [ ] **Far and off.** A character at 300 m (far) killed by `castHit` falls with its baked death clip
      and freezes. Its `Reaction` matches a near character's state by state.
- [ ] **Hit tests agree.** For one animation time, a ray at the head returns `head` with points within
      1 cm on near, mid, far, off, and a headless server. `ragdoll/hit-test` stays within its unit
      budget.
- [ ] **Multiplayer.** Two peers (`run --net`): the server knocks a character down. Both clients simulate a
      ragdoll, both rest in the server's rest, and after the get-up both draw it within 0.05 m of the
      server's root. Reaction traffic is at most 16 bytes per hit.
- [ ] **Deterministic.** `shard run --frames 600` with scripted hits prints the same hash twice.
- [ ] **`ragdoll-fight` scenario.** The 500 fixture (`horde-walk` bands) with 12 partial, 12 full and
      100 corpses: frames within `ragdoll-fight` (laptop), with `ragdoll/drive`, `ragdoll/blend` and
      the physics step within their shares. Proposed: like `horde-walk` plus 1.5 ms, the step 1.0 ms,
      drive and blend 0.3 ms together.

## As built (in progress)

Built against `main` at `a2a9a19` (2026-11-14), on the fixture: Risen's `base.glb` (53 joints) with
CMU walk, idle and attack clips, stand-in rest and get-up clips (`@aethervtt/shard-ragdoll/testing`,
the top joint turned a quarter and lowered; real games author these), and the deterministic Rapier
variant. Measured on an Apple M5 Max (not a named machine).

- **Generation.** `generateRagdoll` (and `shard ragdoll gen`) finds the 14 humanoid bodies on the
  game-engine rig, boxes the pelvis and spine, capsules the limbs and head, hinges elbows and knees
  with axes from the rest pose (knees bend back from heel-to-toe forward), and writes each body's
  rest pose. Masses sum to 1.
- **Limits.** `checkRagdoll` (and `shard ragdoll check`): 100 random hits of 50–500 N·s (seeds
  1–4) give 0 NaN and 0 joints under the ground; 99 of 100 trials end within 5° of every limit,
  and one ends a foot 21° past its swing. At Rapier's default 4 iterations, without the 12 extra,
  joints ended 70–100° past.
- **Partial while walking.** Two twins on the same walk frame, one hit with 40 N·s at
  `upperarm_l`: within 0.3 s the arm turns more than 15° from its twin, chest and head more than 3°.
  The pelvis and feet stay within 1 mm of the twin's throughout, and by `recover` + 0.1 s every
  bone is within 0.5° and the slot is free. The spec's 15° for chest and head isn't reached at
  40 N·s with the default profile.
- **Leg and head hits.** A 40 N·s hit at `calf_l` keeps both feet within 1 mm of the walk and turns
  the chest more than 2°. A 55 N·s head shot on a zombie walking at 0.9 m/s (moved by Transform)
  pushes the head back 2–4 cm in about 0.2 s, never swings it past the walk the other way (less
  than 20% of the push), and takes at least 1.3 times as long to come back. Before, the body was
  activated without the root's motion and leaned 31 cm back, then caught up; with that fixed, the
  head still nodded 3 cm back and 3 cm forward from gravity under a weakened drive.
- **Knockdown, rest and get-up.** 175 N·s at the chest fells it (pelvis under 0.4 m within 1.5 s),
  picks `lie-back` (hit from the front), rests, gets up on the stand-in clip and stands.
- **Corpses.** A death freezes once settled: no bodies, rig back in the pool, `CharacterTier.frozen`.
- **Hit tests.** Head shots return `head` with points within 1 cm near (joints) and off (sampled
  on demand); `castHit` refines through the sensor capsule a root gets; a plain root with no
  skeleton hit-tests against the asset's rest poses.
- **Drives and roles.** `drive: 'game'` stops at rested with no clip played until `stand()`; a
  launch moves every body at the launch velocity; a mapped `hit.light` plays as an additive layer.
- **Car hits.** A 9 m/s launch: the drawn pelvis never moves more than 0.3 m in a frame, it lands
  more than 2 m away, and the rest blend moves it less than 0.35 m.
- **Codec.** `Reaction` is 16 bytes on the wire.
- **Under fire.** 8 zombies hit in one frame with `maxActive` 4: never more than 4 simulate; the
  larger on screen take slots from smaller ones, which blend out and show clips only.
- **Playground.** `#ragdoll`: 14 zombies shambling at the camera. Click shoots, Shift+click knocks
  down, Alt+click kills, N shoots the nearest, C launches the one under the cursor, O shows bodies.

Not built or not measured yet: the timing budgets (`ragdoll/idle`, `ragdoll/hit-test`, the
`ragdoll-fight` scenario) and their bench; the two-peer replication test and `shard run` hash
check; the momentum, steer-accuracy and no-pop vertex
criteria; `gen --clips` against real clips; IK fades to 0 at once while full rather than over
`ikFade`; a rested character evicted while frozen thaws without a test.

## Open questions

- **Corpse piles.** A frozen corpse has no colliders, so a new ragdoll falls through onto the ground
  beneath it. Proposed: accept for now. If it shows, frozen corpses keep one static compound of
  three capsules (torso, thighs), at the cost of a static collider each.
- **Matching corpses.** If a game needs everyone to see the same sprawl (bodies as cover with
  `blockCharacters`), the server sends one frozen pose per corpse (14 rotations at 4 bytes, plus the
  pelvis: about 70 bytes) and clients blend to it over 0.3 s. It would come from a client or a pose
  library picked by fall direction, since the server doesn't simulate. Proposed: later, when a game
  asks for it.
- **Melee as a held force.** A shove lasts several frames. Proposed: a hit with `duration` spreads
  its impulse over steps. Leave it out until a melee prototype shows a single impulse isn't enough.
  A car is covered by `launch`.
- **Lying characters that aren't knocked down.** Risen's zombies also rest by choice (sitting,
  lying) with no ragdoll. A hit on one should use that rest's pose for hit tests and stay down.
  Proposed: the game's pose source covers hit tests; whether a hit on a resting character ragdolls
  or plays a clip is the game's, through `kind`.
