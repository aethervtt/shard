# 0048 — Creatures

- **Status:** accepted
- **Packages:** `@aethervtt/shard-creatures` (new), `@aethervtt/shard-procgen`, `@aethervtt/shard-mesh`, `@aethervtt/shard-animation`,
  `@aethervtt/shard-nav`, `@aethervtt/shard-terrain`
- **Depends on:** 0029, 0032, 0033, 0034, 0037, 0041, 0042, 0043, 0045

## Context

The proof project's planets need wildlife: grazers in herds, skittish critters that flee, flyers
circling cliffs, and predators that stalk the player. Each planet has its own species, generated
from its seed, so no two worlds share a fauna. VISION lists creatures as proving "procedural meshes
and skeletons, animation, simple AI/navigation on terrain".

Hand-animating every generated body is impossible, and retargeting one biped clip set onto a
six-legged thing doesn't work either. So creatures move mostly **procedurally**: a gait
generator steps each leg with the IK from 0034, the spine and tail follow with FABRIK chains, and
the head looks at what the creature cares about. Clips are used only for the expressive bits
(idle fidgets, eating, attacks). They're authored once per **body plan** and retargeted (0034)
onto every species of that plan, whatever its proportions.

A species is data: body plan, proportions, skin pattern, size, diet, and temperament. An individual
is an entity spawned near the player. Populations follow the scatter rules of 0045, so a forest
biome has its own animals the same way it has its own trees.

## Goals

- **Body plans**: biped, quadruped, hexapod, serpent, flyer (wings), swimmer (fins), and a
  `blob` for oddities. Each is a template skeleton with canonical joint names and ranges for
  proportions.
- `shard/Species` generator (data output): body plan, proportions, size, palette and pattern,
  diet, temperament, speeds, senses, and a generated name, all from `(planet seed, biome, index)`.
- `shard/Creature` generator (entities output): skeleton, skinned mesh with LODs, material, gait,
  IK, collider, and behavior components for a species.
- Procedural locomotion: gait patterns (walk, trot, gallop, and a ripple gait for hexapods),
  footstep placement on terrain with IK, body height and tilt from the feet, spine and tail
  follow-through, wing flaps, and serpentine and swim undulation.
- Per-body-plan clip sets (idle, eat, attack, hurt, die, sleep), retargeted to each species.
- Behavior as data: a small utility-scored state set (wander, graze, flee, follow herd, stalk,
  attack, sleep, drink), with perception (sight cone, hearing radius) and day/night schedules.
- Herds (cohesion, separation, and a leader), predator-prey reactions, and reactions to the player.
- Populations per biome, spawned near the player through 0045's scatter as a `creature` rule kind,
  despawned when far, deterministic in where herds start.
- Flyers and swimmers without navmeshes: steering in 3D, kept above terrain or below sea level with
  `planetHeightAt` queries.
- Budget: 200 active animated creatures at 60 fps.

## Non-goals

- Physically simulated locomotion (active ragdolls, learned controllers).
- Ecosystem simulation over time: populations don't grow or starve. Spawning is stateless.
- Taming, riding, and breeding (game code on top of these components).
- Full-body IK (VISION "later"). Two-bone and FABRIK per limb and chain are enough.

## Design

### Body plans

- A body plan is a data asset (`*.bodyplan.json`, type `BodyPlan`) that ships with the engine
  and can be overridden. It holds a template skeleton (joints with canonical names such as `spine.0`,
  `leg.fl.upper`, and `wing.l.tip`), the proportion parameters and their ranges, the leg groups
  and default gait phases, the IK setup, the clip set, and the mesh recipe.
- Proportions are named scalars per plan: body length, girth, neck length, leg length front and
  back, tail length, head size, wing span, and so on. The skeleton builder scales joint offsets
  from them. Limits keep the result plausible (legs can't be shorter than the belly clearance).
- Species vary within a plan. Plans are the unit that clips and gaits are authored for.

### Species

```ts
SpeciesInfo {                            // data type; shard/Species output
  name: string                           // generated: syllable model seeded per planet
  plan: handle('BodyPlan'), proportions: json, size: f32 /* metres, body length */
  palette: list(color), pattern: 'solid' | 'stripes' | 'spots' | 'patches' | 'gradient',
  patternScale: f32, roughness: f32, iridescence: f32
  diet: 'herbivore' | 'carnivore' | 'omnivore', temperament: 'skittish' | 'calm' | 'territorial' | 'aggressive'
  herd: vec2 /* min, max group size */, speeds: vec3 /* walk, run, sprint m/s */
  senses: struct { sight: f32, fov: f32, hearing: f32 }
  activity: 'diurnal' | 'nocturnal' | 'any'
  call: handle('Generator') /* 0050's shard/CreatureCall with params */
}
```

- `shard/PlanetFauna` (data output) lists species per biome for a planet. It picks 2–6 per
  biome, weighted by biome richness, with plans that suit the biome (swimmers only with oceans,
  flyers more often in mountains). Each species' seed is `childSeed(planetSeed, biome, i)`, so the
  same planet has the same animals.
- Size drives speed, sense ranges, and mass (≈ density × volume) within the plan's limits. It
  scales from 0.2 m critters to 8 m giants.

### Mesh and skin

- `shard/Creature` builds the body as a **convolution surface** around the skeleton: capsule-like
  implicit primitives per bone, with radii from the proportions, blended smoothly. It's polygonized
  with surface nets on the worker (a WASM kernel added to `crates/shard-noise`), then relaxed.
  Head, horns, and fins are optional attachments from the plan's recipe, as small generated meshes
  merged in.
- Skin weights come from distance to each bone segment with a smooth falloff, up to four
  influences, and normalized. The rest pose is the template's rest pose, so skinning (0032) works
  as for any glTF.
- UVs are a per-bone cylindrical unwrap, which is enough for procedural patterns. The material
  (`creatures/Skin`, extends `standard`) computes stripes, spots, and patches from 0041 noise in
  object space, with colors from the palette, belly lightening, and optional iridescence.
- LODs come from meshoptimizer (0045). The collider is a capsule or a compound of capsules for
  large bodies.
- The output is cached like any generator, so a species' mesh generates once per session.

### Locomotion

```ts
Gait { plan: string, phases: list(f32), duty: f32, strideLength: f32, stepHeight: f32,
       bodyBob: f32, speedToGait: list(vec2) /* speed → gait index */ }
CreatureMotor { velocity: vec3, desiredVelocity: vec3, turnRate: f32 }
```

- Ground creatures move through the character controller (0029) with spherical gravity. The motor
  turns desired velocity into movement, and the gait reads actual velocity.
- **Stepping** (`creatures/gait`, PostUpdate before IK): each leg has a phase. When its phase
  enters swing, it picks a landing point ahead along the velocity, at `strideLength × speed ratio`,
  raycast to the ground (0034's foot-placement raycast), and moves the IK target there along an arc
  of `stepHeight`. In stance, the foot stays planted in world space. The body's height and pitch/roll
  are fit to the planted feet.
- Gait selection blends phase offsets by speed (walk → trot → gallop for quadrupeds; ripple for
  hexapods; a biped alternates). Transitions re-time phases over half a cycle, so feet never teleport.
- **Follow-through**: `ChainIk` (0034) on spine and tail, targeted by a lagged spring on the body's
  path, gives wagging, sway, and serpentine motion. Serpents move entirely by the spine wave (a
  traveling sine along the chain, amplitude from speed).
- **Flyers**: wing joints driven by a flap oscillator (frequency and amplitude from speed and climb),
  and a glide pose above cruise speed. Movement is 3D steering with lift-ish constraints (bank into
  turns, max climb rate), not the character controller.
- **Swimmers**: body undulation like serpents plus fin oscillators, with 3D steering bounded by
  the sea surface and the seabed.
- **Clips** layer on top through 0033 graphs with masks. The plan's graph has a locomotion layer
  that's procedural (no clip) and upper-body or head layers for eat, attack, and idle fidgets, all
  retargeted from the plan's authored skeleton (0034 `Retarget` with the plan's `JointMap`).
- **Look-at**: `LookAtIk` on head and neck, targeting the current focus (threat, food, player),
  within the plan's limits.

### Behavior

```ts
Behavior { species: handle('SpeciesInfo'), state: string, focus: entity, home: vec3,
           stress: f32, hunger: f32 }
```

- `creatures/perceive` (FixedUpdate, at 5 Hz per creature, staggered) finds other creatures and
  players within sight (cone plus line-of-sight raycast) and hearing (radius scaled by the source's
  noise: running is louder than walking). It writes a small fixed-size percept list per creature.
- `creatures/decide` scores each state with utility curves from the species' temperament, diet,
  needs, time of day (0046 `Spin` gives local solar time), and percepts. The highest wins, with
  hysteresis. States: `wander` (nav target in the home radius), `graze` (stop and play the eat clip
  on food biomes), `drink`, `sleep`, `follow` (herd), `flee` (away from the threat, sprint, herd
  scatters), `stalk` (approach at walk speed staying out of sight cones), `attack` (charge, play the
  attack clip, emit `CreatureAttack`), and `investigate` (approach a sound).
- Movement goals become `NavAgent` destinations on 0043's `PlanetNav` tiles. Herds steer with
  separation, cohesion, and alignment added to the nav agent's desired velocity, following a leader
  (the first member).
- Gameplay hooks are events: `CreatureStateChanged`, `CreatureAttack { attacker, target }`,
  `CreatureNoticed { creature, target }`. Health, damage, and loot are game code.
- Behavior data is overridable per species (`behavior: handle('BehaviorProfile')`), so a project
  can make everything on one planet hostile without touching generators.

### Populations

- 0045 gains a `creature` rule kind: `{ "kind": "creature", "species": "fauna:0", "density":
  0.0002, "range": 250 }`. `fauna:<i>` picks the biome's i-th species from the planet's fauna
  list. Herds spawn as a group at a lattice point, with the group size drawn from the species' range.
- Spawning happens outside the view frustum when possible, or at the range edge, and is budgeted.
  Creatures beyond `range × 1.2` that aren't in view despawn. They're transient: a kill is not
  remembered by default (`persistent: true` on a rule saves kills per lattice point, like 0045
  props).
- **LOD**: beyond 60 m, perception and decision drop to 1 Hz, IK turns off beyond 80 m (the plain
  gait pose), and the animation update halves in rate beyond 120 m. With these cuts, 200 active
  creatures fit the budget.

### Agent surface

- `creatures.describe { planet? }` returns the fauna per biome (species, plan, size, temperament),
  the active creatures with state, focus, and LOD tier, and timings per system.
- `creatures.species { id }` returns the full `SpeciesInfo`, and `creatures.spawn { species,
  position }` spawns one for testing.
- `procgen.preview` of `shard/Creature` renders a species turntable, and of `shard/PlanetFauna`
  renders a lineup of a planet's species to scale with their names. A contact sheet over seeds is
  the loop for tuning a body plan.
- `debug.overlays` gains `creature-senses` (cones and hearing radii), `creature-gait` (foot targets
  and phases), and `creature-state` (floating state labels).
- MCP tools: `describe_creatures`, `spawn_creature`, `species_info`.
- **Errors:** `creatures/bad-proportions` (outside the plan's limits), `creatures/unknown-plan`,
  `creatures/no-nav` (a ground species on a planet without `PlanetNav`), `creatures/unknown-fauna`.

## Decisions

- **Procedural locomotion, clips for expression.** Gaits and IK adapt to any proportions and
  terrain. Authored clips can't cover generated bodies, but they're still best for an attack or a
  yawn, and retargeting within one plan works because the topology matches.
- **Body plans as data.** New plans are files, not engine code, and each gets its own proportions,
  gaits, and clip set.
- **Convolution surfaces.** Smooth organic bodies from any skeleton with no manual modelling, and
  the skin weights follow from the same bone distances.
- **Utility scoring over behavior trees.** A few curves per temperament produce believable
  reactions and are easy for an agent to tune numerically. Trees would need authoring per species.
- **Stateless populations.** Spawning from the scatter lattice means nothing to save and nothing to
  simulate off-screen, which matches the proof project's scale.

## Acceptance criteria

- [ ] `shard/PlanetFauna` for the same planet seed gives the same species (names, plans, and
      proportions) on Node, Chrome, and Tauri, and 1 000 seeds produce all body plans.
- [ ] Each body plan's nine-seed turntable contact sheet matches its golden. Meshes are watertight,
      and skinning shows no candy-wrapper or collapse artifacts at the clip set's extreme poses (golden
      per plan).
- [ ] A quadruped walking, trotting, and galloping across a 25° slope keeps planted feet within 3 cm
      of the ground (measured against CPU terrain heights), and no foot slides more than 2 cm during
      stance.
- [ ] Gait transitions from walk to gallop and back produce no foot position jump over 5 cm between
      frames.
- [ ] A herd of 8 grazers flees from an approaching predator or player and regroups after, and a
      skittish species notices a running player at a greater distance than a walking one (headless
      test).
- [ ] Flyers never go below terrain and swimmers never leave the water over a 10-minute headless
      run on the example planet.
- [ ] 200 active creatures (mixed plans, LOD active) run under 4 ms CPU and 2 ms GPU per frame on
      the desktop (budgets `creatures/update` and `gpu:creatures`, proposed).
- [ ] The same planet location spawns the same herd (species, count, starting positions) on every
      visit.

## Open questions

- Should species evolve per biome from a shared ancestor per planet (similar colors and features),
  or be fully independent? Proposed: a planet "fauna palette" seed biases all species slightly, so
  a world feels coherent.
- None blocking. Deferred: ragdolls on death (VISION later), creature-creature fighting beyond
  events, and flocking at the scale of hundreds of flyers (GPU boids).
