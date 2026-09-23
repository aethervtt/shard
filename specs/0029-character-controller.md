# 0029 — Character controller

- **Status:** accepted
- **Packages:** `@shard/physics`
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

- `CharacterController`: a kinematic capsule (or circle in 2D) that moves by intent, slides along
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
  radius: f32 = 0.35, height: f32 = 1.8                 // capsule, total height in m
  stepHeight: f32 = 0.3, maxSlope: f32 = 45 (deg), snapDistance: f32 = 0.2
  up: 'fixed' | 'gravity', fixedUp: vec3 = [0, 1, 0]
  gravity: f32 = 9.81                                   // used when up is 'fixed' and no source
  jumpSpeed: f32 = 5, airControl: f32 = 0.3
  pushForce: f32 = 50 (N), layers: u32, mask: u32
  alignRotation: bool = true                            // turn the entity so its +Y matches up
}
CharacterIntent { move: vec3 (m/s, in the character's local frame), jump: bool }   // written by games
CharacterState {                                          // written by the controller, readonly
  grounded: bool, groundNormal: vec3, groundEntity: entity,
  velocity: vec3, up: vec3, airTime: f32
}
```

- `move` is local: X right, Z back (−Z forward), matching the transform convention. The
  controller projects it onto the ground plane, so the same intent walks up a slope or around a
  planet.
- A character entity has `CharacterController` and no `RigidBody`. The controller makes its own
  kinematic body and collider, so it shows up in queries and events.

### Each step

In `FixedUpdate`, after `physics/sync-in` and before `physics/step`:

1. **Up.** `'gravity'` samples every `GravitySource` at the position and takes the strongest pull
   as down. `alignRotation` rotates the entity by the smallest turn that maps its +Y to the new up,
   so heading is kept.
2. **Velocity.** Grounded: `velocity = move projected on the ground`, and `jump` adds
   `jumpSpeed * up`. Airborne: gravity accumulates along −up and `move` blends in by `airControl`.
3. **Move.** Rapier's `KinematicCharacterController.computeColliderMovement` with the controller's
   up, slope limits, autostep, and snap, and the result is written to the kinematic body.
4. **State.** `grounded`, the ground normal and entity, and the velocity go to `CharacterState`.
   Landing and leaving the ground send `CharacterGroundEvent { entity, grounded }`.
5. **Pushing and platforms.** Contacts with dynamic bodies apply `pushForce` along the move. When
   the ground entity is a kinematic body, its velocity at the contact point is added to the move.

### Agent surface

- The components are in the catalog. `CharacterState` is readable through `entity.get`, so a
  gameplay test asserts "the character is grounded after 60 frames" without screenshots.
- `physics.describe` lists controllers with their state.
- The `colliders` overlay draws controller capsules and the up vector.
- The `add-physics` skill gains a character section with a walking test.

## Decisions

- **Kinematic, not dynamic.** A dynamic capsule needs friction and damping tuning to stop sliding
  and bouncing. A kinematic controller does exactly what its intent says, which is what agents can
  reason about and tests can assert.
- **Intent in, state out.** Games and agents write `CharacterIntent` from input or AI and read
  `CharacterState`. The controller owns velocity, gravity, and jumping, so there's one place that
  integrates them.
- **Up comes from gravity sources.** The same `GravitySource` that pulls rocks toward a planet
  orients the player, so walking around a planet needs no special code.

## Acceptance criteria

- [ ] A character with `move: [0, 0, -3]` walks 3 m/s on flat ground, climbs a 0.25 m step,
      stops at a 0.4 m step, walks up a 40° slope, and doesn't slide down a 44° slope at rest.
- [ ] A jump reaches `jumpSpeed² / 2g` height within 5%, and `CharacterGroundEvent` fires on
      takeoff and landing.
- [ ] On a sphere with a `GravitySource`, walking forward for long enough circles the planet and
      returns within 1 m of the start, grounded the whole way, with +Y pointing away from the center.
- [ ] Standing on a moving kinematic platform carries the character with it.
- [ ] Walking into a 10 kg dynamic box pushes it.
- [ ] A 2D character walks, jumps between platforms, and stands on a polyline collider.
- [ ] 100 controllers step in under 1.5 ms per step (bench).

## Open questions

- None blocking.
