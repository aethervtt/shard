# 0029 — Character controller

- **Status:** implemented
- **Packages:** `@aethervtt/shard-physics`
- **Depends on:** 0008, 0028

## Context

Walking is the first thing a player does on a planet, and it's where physics feels worst when
done with a raw rigid body: characters slide down slopes, catch on stair edges, and bounce off
bumps. Every engine ships a kinematic character controller for this. Rapier has one, and it
handles slopes, steps, and ground snapping.

Shard needs one more thing most controllers skip: "up" isn't always +Y. On a small planet, up
points away from the planet's center and turns as you walk around it. A 2D platformer needs the
same controller in the plane.

## Goals

- `CharacterController`: a kinematic capsule (2D capsule in 2D) that moves by intent, slides along
  walls, climbs steps, walks slopes up to a limit, and snaps to the ground.
- Up from gravity: fixed, or from the strongest `GravitySource` at the character's position,
  with the character's rotation turned to match.
- Gravity, jumping, and ground state computed by the controller, so games only write intent.
- Pushing dynamic bodies it walks into, and riding moving platforms.
- The same component in 2D and 3D.

## Non-goals

- Animation, IK foot placement (0032, 0034), and cameras.
- Swimming, climbing, crouch shape changes (game logic on the same component).
- Networked prediction.

## Design

### Components

```ts
CharacterController {
  radius: f32 = 0.35, height: f32 = 1.8                 // capsule centered on the entity, total height in m
  stepHeight: f32 = 0.3, maxSlope: f32 = 45 (deg), snapDistance: f32 = 0.2
  up: 'fixed' | 'gravity', fixedUp: vec3 = [0, 1, 0]
  gravity: f32 = 9.81                                   // fall acceleration when up is 'fixed'
  jumpSpeed: f32 = 5, airControl: f32 = 0.3             // airControl: share of the way to intent per 1/60 s
  pushForce: f32 = 200 (N), layers: u16 = 1, mask: u16 = 0xffff
  alignRotation: bool = true                            // turn the entity so its +Y matches up
}
CharacterIntent { move: vec3 (m/s, in the character's local frame), jump: bool }   // written by games
CharacterGroundEvent { entity, grounded }                // landed (true) or left the ground (false)
CharacterState {                                          // written by the controller, readonly
  grounded: bool, groundNormal: vec3, groundEntity: entity,
  velocity: vec3, up: vec3, airTime: f32
}
```

- `move` is local: X right, Z back (−Z forward), matching the transform convention. The
  controller projects it onto the ground plane, so the same intent walks up a slope or around a
  planet.
- A character entity has `CharacterController` and no `RigidBody` or `Collider` (that's a
  `physics/character-has-body` error). The controller makes its own kinematic body and capsule, so
  it shows up in queries and events. Colliders on children ride on its body.
- `move.y` is ignored (jump instead); in 2D, `move.x` walks. `jump` jumps at the next grounded step
  and the controller clears it, so setting it while airborne buffers the jump until landing.
- The Transform is the source of truth: writing its rotation turns the character, and writing its
  translation teleports it.
- `layers`/`mask` are u16 like `Collider`'s, since Rapier's collision groups are 16 bits each.

### Each step

In `FixedUpdate`, after `physics/sync-in` and before `physics/step`:

1. **Up.** `'gravity'` samples every `GravitySource` at the position and takes the strongest pull
   as down. Where no source reaches, `physics/Config` gravity is down; with none at all the last up
   is kept. `alignRotation` rotates the entity by the smallest turn that maps its +Y to the new up,
   so heading is kept.
2. **Velocity.** Grounded: `move`, following the ground down slopes (same horizontal speed) so it
   stays on them, and level uphill, where Rapier's slope climbing and autostep take over. Rising
   with uphill normals launched the character off step edges, whose rounded corners read as
   slopes. `jump` adds `jumpSpeed * up`. Airborne: gravity
   accumulates along −up and `move` blends in by `airControl`. The displacement is velocity-Verlet
   (`v·dt + ½·g·dt²`), exact under constant gravity, so jump heights match `jumpSpeed² / 2g`.
3. **Move.** Rapier's `KinematicCharacterController.computeColliderMovement` with the controller's
   up, slope limits, autostep, and snap (off while rising, so jumps leave the ground), and the
   result is written to the kinematic body and the Transform. On the ground nothing pushes down into
   it: snapping holds it, and a push makes Rapier drag the character along moving ground by
   friction, a step late, which doubles the platform carry below.
4. **State.** `grounded`, the ground normal and entity, and the velocity go to `CharacterState`.
   The ground comes from the move's walkable collisions, or, when snapping held the character down
   without touching anything, a short ray down along −up. Landing and leaving the ground send
   `CharacterGroundEvent { entity, grounded }`.
5. **Pushing and platforms.** Contacts with dynamic bodies apply up to `pushForce · dt` of impulse
   along the move, never pushing a body faster than the character walks. When the ground entity is
   a kinematic body, the motion of the character's position over the step is added to the move:
   from the body's next pose for `kinematic-position`, from its velocities for `kinematic-velocity`.

### Agent surface

- The components are in the catalog. `CharacterState` is readable through `entity.get`, so a
  gameplay test asserts "the character is grounded after 60 frames" without screenshots.
- `physics.describe` lists controllers with their state (`characters`); their bodies and capsules
  aren't counted in `bodies` and `colliders`.
- The `colliders` overlay draws controller capsules (cyan) and the up vector (yellow).
- The `add-physics` skill gains a character section with a walking test.

## Decisions

- **Kinematic, not dynamic.** A dynamic capsule needs friction and damping tuning to stop sliding
  and bouncing. A kinematic controller does exactly what its intent says, which is what agents can
  reason about and tests can assert.
- **Intent in, state out.** Games and agents write `CharacterIntent` from input or AI and read
  `CharacterState`. The controller owns velocity, gravity, and jumping, so there's one place that
  integrates them.
- **pushForce defaults to 200 N, not 50.** A 10 kg box at friction 0.5 resists with 49 N, so 50 N
  barely moved it. The push is capped at walking speed, so a stronger default doesn't fling boxes.
- **Our own platform carry, not Rapier's.** Rapier's controller only carries by contact friction:
  a step late, sometimes stalling for a step, and only while pushing into the ground. Computing
  the carry from the platform's next pose is exact.
- **Up comes from gravity sources.** The same `GravitySource` that pulls rocks toward a planet
  orients the player, so walking around a planet needs no special code.

## Acceptance criteria

- [x] A character with `move: [0, 0, -3]` walks 3 m/s on flat ground, climbs a 0.25 m step,
      stops at a 0.4 m step, walks up a 40° slope, and doesn't slide down a 44° slope at rest.
- [x] A jump reaches `jumpSpeed² / 2g` height within 5%, and `CharacterGroundEvent` fires on
      takeoff and landing.
- [x] On a sphere with a `GravitySource`, walking forward for long enough circles the planet and
      returns within 1 m of the start, grounded the whole way, with +Y pointing away from the center.
- [x] Standing on a moving kinematic platform carries the character with it.
- [x] Walking into a 10 kg dynamic box pushes it.
- [x] A 2D character walks, jumps between platforms, and stands on a polyline collider.
- [x] 100 controllers step in under 1.5 ms per step (bench): 1.0 ms for the controller system, 1.06 ms
      with the physics step, on the laptop (budget `physics/characters`).

## Open questions

- None blocking.
