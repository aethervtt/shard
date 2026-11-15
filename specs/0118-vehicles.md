# 0118 — Wheeled vehicles: suspension, tires, drivetrain, surfaces, and hooks

- **Status:** draft (built 2026-11-14). Implemented once its criteria pass in CI.
- **Packages:** `@aethervtt/shard-vehicle` (new), `@aethervtt/shard-physics`,
  `@aethervtt/shard-terrain`, `@aethervtt/shard-net`, `@aethervtt/shard-project`, `apps/cli`,
  `apps/playground`
- **Depends on:** 0028, 0029, 0035, 0053, 0071, 0077, 0082, 0026, 0087, 0088, 0117

## Context

Games need cars, trucks and trailers that drive: Risen has parked cars on every lot that players
should be able to start, drive through a horde, get stuck in mud with, and hear from a block away.
VISION lists "vehicle helpers" under Later, 0028 left vehicles out, and 0088 left open whether a
client may predict a physics body it drives.

Every engine converges on the same model (research: `research/vehicles-2026-11-14.md`). The chassis
is one rigid body. Each wheel is a query from a hardpoint down the suspension axis, not a body: a
spring and damper push the chassis up at the contact, a tire model turns the contact point's slip
into a force, and a drivetrain (engine, clutch, gearbox, differentials) turns throttle into wheel
torque. Unreal's Chaos Vehicles, Unity's WheelCollider, PhysX's vehicle SDK, Jolt's
`VehicleConstraint`, Godot's `VehicleBody3D` and Bullet's raycast vehicle all have this shape; they
differ in the tire model, the low-speed handling, and how much drivetrain they ship.

Rapier ships a `DynamicRayCastVehicleController` (a port of Bullet's): ray-only suspension and two
friction scalars (`frictionSlip`, a cap, and `sideFrictionStiffness`), with no tire curves, wheel
spin state, drivetrain (engine input is a force), surfaces, or low-speed handling, and it sets the
chassis velocity itself inside `updateVehicle`. This spec builds the wheel model in TypeScript on
top of Rapier's body, queries and impulses, the way 0029's controller builds on Rapier's character
primitives.

## Goals

- A vehicle is a prefab: a dynamic chassis with `Vehicle`, child wheel entities with `VehicleWheel`,
  and optional `VehicleEngine`, `VehicleTransmission` and `VehicleAssists`. A trailer is a vehicle
  with no engine, hitched by a `Joint`.
- **Suspension:** spring and damper per wheel, authored as frequency and damping ratio, travel
  limits with a bump stop, anti-roll bars per axle. The authored wheel position is the ride height.
- **Tires:** slip-curve tire model with combined slip, load sensitivity, rolling resistance, and
  stable low-speed and standstill behavior at a 60 Hz step. Tires are shareable data assets.
- **Steering:** rate-limited, speed-sensitive, Ackermann geometry, rear steer.
- **Drivetrain:** torque curve, idle and limiter, engine braking, clutch, gearbox with automatic or
  manual shifting, open, limited-slip and locked differentials, center split for AWD, brakes and
  handbrake.
- **Surfaces:** a `Surface` asset in physics (grip, rolling resistance, looseness, sinkage, digging,
  bumps, wetness) on colliders and terrain layers. Snow, sand and mud drive differently from
  asphalt, and a tire's grip depends on the surface.
- **Stability and feel:** center of mass override, tire force height, anti-roll, ABS, traction
  control, stability control, counter-steer and drift assists, downforce, air control, self-right.
  `sim` and `arcade` presets set them.
- **Hooks:** wheel visuals (spin, steer, suspension), engine and tire audio parameters with
  per-surface switching, shift, stall, bottom-out, landing and hit events, particles and tire
  tracks per surface.
- **Seats:** enter and exit a vehicle with a character, with a clear exit point.
- **Characters are hit, not collided:** a car plows through a horde losing momentum by mass ratio,
  and reports each hit for 0117's `launch`.
- **Multiplayer:** the driver's client drives without input lag; the server validates.
- **Agent tuning loop:** `shard vehicle gen` makes a prefab from a car model; `shard vehicle test`
  runs headless maneuvers (0–100, braking, skidpad, step steer, climb) and reports numbers.

## Non-goals

- Motorcycles (lean and balance control), tracked vehicles, aircraft and boats. `side: 'center'`
  wheels and the drivetrain leave room for them; 0100's `Buoyancy` floats any body.
- Soft-body or mesh deformation, detachable parts and damage models. Games scale grip and torque.
- Tire temperature, wear and pressure; turbo and hybrid models; clutch wear.
- Deforming terrain or snow geometry. Tracks are trails (0082), sinkage is visual and per wheel.
- A chase camera. Games have their own (Risen's 0003); a `controls` follow mode can come later.
- Server-authoritative predicted vehicles (rollback of one body inside Rapier). See Decisions.
- 2D vehicles.

## Design

### Prefab shape

```
car (RigidBody dynamic, Collider(s), Mass { mass, center: 'authored', centerOfMass },
     Vehicle, VehicleEngine, VehicleTransmission, VehicleAssists, VehicleInput)
├─ body (Model)
├─ wheel.fl (VehicleWheel { axle: 0, side: 'left', visual: → body/wheel_fl })
├─ wheel.fr  wheel.rl  wheel.rr
└─ seat.driver (VehicleSeat { role: 'driver', exit: [-1.2, 0, 0] })
```

A wheel entity's position is its hardpoint: the wheel center **at ride height**, where the model
draws it. The spring's rest length is solved from the sprung mass so the car settles there, so a
model's wheel nodes are the right positions without tuning.

### Components

```ts
Vehicle {
  axles: list({
    steer: f32 = 0              // share of steering: 1 front, −0.3 rear steer, 0 none
    drive: f32 = 0              // share of engine torque after the center split (0..1, sums to 1)
    differential: 'open' | 'limited-slip' | 'locked' = 'open'
    torqueBias: f32 = 3         // limited-slip: max torque ratio between the sides (a torque ratio,
                                // not Jolt's or PhysX's wheel-speed ratio)
    preload: f32 = 50 (N·m)     // limited-slip: locking torque with no input torque
    antiRoll: f32 = 0 (N/m)     // per metre of compression difference between the sides
    brakeTorque: f32 = 1500 (N·m), handbrakeTorque: f32 = 0 (N·m)
  })
  centerDiff: 'open' | 'limited-slip' | 'locked' = 'open', centerTorqueBias: f32 = 3
  steer: { maxAngle: f32 = 35 (deg), ackermann: f32 = 1, speed: f32 = 180 (deg/s),
           returnSpeed: f32 = 360 (deg/s), atSpeed: list(vec2) = [[0, 1], [30, 0.35]] }  // (m/s, scale)
  aeroDrag: f32 = 0.4 (N·s²/m²) // ½ ρ Cd A: sets top speed with the engine
  substeps: u8 = 4              // drivetrain and tire integration per physics step
  iterations: u8 = 3            // passes over the wheels per substep
  probe: 'ray' | 'cylinder' = 'cylinder', mask: u16 = 0xffff
}
VehicleWheel {
  axle: u8, side: 'left' | 'right' | 'center'
  radius: f32 (m), width: f32 (m), mass: f32 = 20 (kg)          // spin inertia ≈ ½ m r²
  tire: handle('Tire')                                           // default: road tire
  frequency: f32 = 1.6 (Hz), damping: vec2 = [0.4, 0.6]          // ratio: bump, rebound
  travel: vec2 = [0.12, 0.15] (m)                                // up, down from ride height
  camber: f32 = 0 (deg), forceHeight: f32 = 0.3                  // 0 contact … 1 center-of-mass height
  gripScale: f32 = 1                                             // games: flats, damage
  visual: entity, visualName: string                             // a model node found by name
}
VehicleEngine {
  torque: list(vec2)  // (rpm, N·m), rpm increasing
  idleRpm: f32 = 800, maxRpm: f32 = 6500, stallRpm: f32 = 500, stall: bool = false
  inertia: f32 = 0.2 (kg·m²), braking: f32 = 60 (N·m at maxRpm)
  running: bool = true, torqueScale: f32 = 1                     // games: keys, fuel, damage
}
VehicleTransmission {
  mode: 'automatic' | 'manual', clutch: 'auto' | 'pedal' = 'auto'
  gears: list(f32) = [3.6, 2.1, 1.4, 1.0, 0.8], reverse: f32 = 3.4, finalDrive: f32 = 3.9
  efficiency: f32 = 0.9, shiftTime: f32 = 0.25 (s), clutchTorque: f32 = 600 (N·m)
  upshift: f32 = 0.85, downshift: f32 = 0.4                      // share of maxRpm, at full throttle
  reverseOnBrake: bool = true                                    // automatic: hold brake at a stop
}
VehicleAssists {
  preset: 'sim' | 'arcade' | 'custom' = 'custom'                 // writes the fields below once
  abs: f32, tcs: f32, esc: f32                                   // 0 off … 1 full
  understeer: f32 = 0.0015 (s²/m: ESC's reference; `vehicle test` measures the car's)
  counterSteer: f32, driftGrip: f32 = 1, driftHold: f32          // arcade drift
  downforce: f32 (N per (m/s)²), airControl: vec3 (N·m), selfRight: bool, antiFlip: f32
}
VehicleInput {   // written by games, input maps, AI, or a net input
  throttle: f32 (0..1), brake: f32 (0..1), steer: f32 (−1..1), handbrake: f32 (0..1)
  clutch: f32 (0..1, pedal mode), shift: i8 (−1, 0, +1; cleared when taken), gear: i8 (manual target)
}
VehicleState {   // readonly
  speed: f32 (m/s, signed forward), rpm: f32, gear: i8 (−1 R, 0 N, 1…), shifting: bool
  clutch: f32, throttle: f32 (after TCS), load: f32 (−1 engine braking … 1 full)
  grounded: u8 (wheels), airTime: f32, driftAngle: f32 (rad), assists: u8 (abs | tcs | esc bits)
}
WheelState {     // readonly, on each wheel entity
  grounded: bool, compression: f32 (0..1), point: vec3, normal: vec3, ground: entity
  surface: u16, load: f32 (N), slipRatio: f32, slipAngle: f32 (rad), skid: f32 (0..1)
  spin: f32 (rad/s), angle: f32 (rad), steer: f32 (rad), sinkage: f32 (m)
}
VehicleSeat { role: 'driver' | 'passenger', exit: vec3, occupant: entity (readonly) }
```

`Tire` (`*.tire.json`, 0031 data type): `grip` (peak μ on a grip-1 surface, 1.0), `longitudinal`
and `lateral` curves (`peakSlip`; `slideSlip` and `slide`, where μ levels off as a share of the
peak; Unity's extremum and asymptote with the peak normalized, PhysX's three-point curve),
`loadSensitivity` (0.1), `rollingResistance` (scale), and `surfaces: map(name → { grip, loose })`
for winter, off-road and slick tires. Built-ins: `road`, `sport`, `offroad`, `winter`.

### Physics prerequisites

- `Mass` gains `center: 'colliders' | 'authored'`, `centerOfMass: vec3` and `inertiaScale: vec3`.
  `authored` gives the body's colliders zero density and sets the whole mass, center and principal
  inertia (the colliders' inertia at that mass, scaled) with Rapier's
  `setAdditionalMassProperties`, which only adds to what dense colliders give. A car's center of
  mass sits low (about 0.45 m) whatever its body collider says; deferred in 0028.
- `PhysicsWorld.applyImpulseAtPoint(entity, impulse, point)` into the body before the step. 0100's
  `applyForceAtPoint` is the same call scaled by `dt`.
- `QueryShape` gains `cylinder` for wheel shape casts.
- **Surfaces.** `Surface` (`*.surface.json`) is a physics data type so footsteps and impacts can
  share it later. `Collider.surface: handle('Surface')`. `registerSurfaceResolver(world, fn)` lets a
  plugin answer per point: the terrain plugin maps a heightfield hit to the two control-page layers
  at that point, and a terrain layer gains `surface` in the source file. Unresolved: `asphalt`.

```ts
Surface {
  grip: f32 = 1, wetGrip: f32 = 0.7         // μ scale, dry and at full wetness
  rollingResistance: f32 = 0.013            // Crr
  loose: f32 = 0                            // 0 paved … 1 deep sand: grip doesn't fall past the peak
  sinkage: f32 = 0 (m at nominal load), drag: f32 = 0 (N·s/m per m of sinkage)
  dig: f32 = 0 (m/s per unit slip), maxSinkage: f32 = 0 (m)
  bumps: { amplitude: f32 (m), wavelength: f32 (m) }
}
```

Starting values, tuned by the `vehicle test` numbers. `grip` is relative to dry asphalt (μ ≈ 0.85),
so a tire's `grip` sets the absolute level. Sources are in the research; grass and mud are guesses.
`Crr` is the whole rolling resistance at walking pace; `drag` adds only the part that grows with
speed and sinkage, so sand isn't counted twice.

| Surface | grip | Crr | loose | sinkage | dig | notes |
|---|---|---|---|---|---|---|
| asphalt, concrete | 1.0 | 0.013 | 0 | 0 | 0 | wetGrip 0.7 (falls further at speed on worn tread) |
| gravel | 0.65 | 0.02 | 0.5 | 0.01 | 0 | bumps 1 cm |
| dirt | 0.6 | 0.05 | 0.4 | 0.02 | 0.01 | wetGrip 0.6 |
| grass (guess) | 0.45 | 0.06 | 0.3 | 0.01 | 0 | wetGrip 0.6 |
| mud (guess) | 0.35 | 0.12 | 0.8 | 0.06 | 0.05 | maxSinkage 0.2 |
| sand | 0.4 | 0.3 | 1 | 0.05 | 0.04 | maxSinkage 0.15 |
| snow (packed / fresh) | 0.25 / 0.25 | 0.03 / 0.08 | 0.4 / 0.8 | 0 / 0.08 | 0 / 0.03 | winter tires via `tire.surfaces` |
| ice | 0.1 | 0.01 | 0 | 0 | 0 | |

`physics/RoadConditions { wetness: f32 }` is a world resource the game sets with its weather.

### Each step

In `FixedUpdate`, after `physics/sync-in` (and `PredictedUpdate`) and before `physics/step`:

1. **Input** (`vehicle/input`). Steering moves toward `steer × maxAngle × atSpeed(speed)` at
   `speed` (back to center at `returnSpeed`), plus `counterSteer × driftAngle`. Each steered wheel
   gets its Ackermann angle from the wheelbase and track (computed from the wheels), blended by
   `ackermann`. The automatic gearbox shifts here (below).
2. **Probe.** Each wheel casts a ray (to `travel.down + radius` below the hardpoint) or a cylinder
   (radius, width, turned by steer; to `travel.down`) from `travel.up` above its hardpoint down the
   suspension axis, excluding the chassis. Hits steeper than 80° are ignored (Jolt's rule), so a
   cylinder rides up a curb but not a wall. The hit gives compression, the contact, the normal, the
   ground entity and its `Surface` (blended by resolver weights), plus `bumps` noise hashed from the
   contact's world position and the wheel's sinkage.
3. **Suspension.** Spring `k = m_sprung (2π f)²`, damper `c = 2 ζ √(k m_sprung)`. Sprung masses
   come from PhysX's `PxVehicleComputeSprungMasses` method: wheels projected on the ground plane,
   exact for one to three supports, and for four or more the masses closest to equal that sum to
   the total and balance about the center of mass. A hitch `Joint` counts as a support, so a
   one-axle trailer rests on it. A negative mass (center of mass outside the supports) is
   `vehicle/bad-sprung-mass`. Force along the suspension axis, never pulling. Anti-roll adds
   `antiRoll × (compression difference in m)` to each side. Past `travel.up` a bump stop takes the
   impulse that stops compression, and fires `bottomOut` above 1 m/s. Load `N` is the spring force
   projected on the contact normal, capped at 3× the wheel's static load.
4. **Substeps** (`substeps`). The vehicle keeps a local copy of the chassis' linear and angular
   velocity, and each substep's impulses update it, so later substeps and wheels see earlier ones
   (PhysX integrates the chassis inside its substeps the same way). Per substep: engine, clutch,
   gearbox and differentials solved implicitly as one system (below), brake torque
   (ABS-modulated), and tires, in `iterations` passes over the wheels:
   - `κ = (ω r − v_x) / max(|v_x|, 1)`, `α = atan2(−v_y, max(|v_x|, 1))` (PhysX floors the
     denominators the same way).
   - Each slip normalized by its curve's peak and combined (`σ = |(σ_x, σ_y)|`); the curve gives
     `μ(σ)`, split back along `σ_x/σ`, `σ_y/σ`: a friction ellipse.
   - `μ` scales by `tire.grip × surface grip (wet-blended) × tire.surfaces[name] × gripScale` and by
     load sensitivity `1 − s (N/N₀ − 1)`, clamped to at least 0.3. `loose` lifts `slide` toward
     1.05 and widens the peak: sand and snow keep pushing back when the wheel spins.
   - Each axis's impulse is capped at the one that zeroes the slip velocity this substep, using the
     effective mass of the chassis share and the wheel together (`1 / (1/m_share + r²/I)`), and the
     same impulse updates `ω`. The wheel is much lighter than the chassis, so a cap from the
     chassis alone would overshoot spin and flip its sign every substep. Jolt caps friction
     impulses the same way, inside its solver.
   - **Standstill** (PhysX's sticky tire): below 0.2 m/s for 1 s with no drive torque, each axis
     approaches zero velocity through a damped target (1 longitudinal, 0.1 lateral per step) that
     includes gravity's `g·Δt`, so a parked car holds on a slope. Its impulses don't wake the body,
     so it sleeps. Unbraked, the longitudinal target is free rolling (`ω r = v_x`).
   - Loose surfaces: drag `drag × sinkage × v` against the contact velocity; sinkage grows by
     `dig × |κ|` up to `maxSinkage` while a wheel spins, and recovers while it rolls.
5. **Apply.** The summed suspension and tire impulses (and the gravity the substeps assumed) go to
   the chassis at each contact, raised toward the center of mass by `forceHeight`, and the opposite
   to a dynamic ground body. Downforce, air control and self-right add their torques.
6. **State.** `VehicleState`, `WheelState`, events. `angle += spin × dt` for the visual.

A vehicle whose chassis sleeps and whose input is zero skips everything: 1,000 parked cars cost a
query walk.

### Drivetrain

- **Engine.** Torque from the curve at engine rpm, × `throttle × torqueScale`; off throttle,
  `braking × rpm/maxRpm` against rotation. A limiter cuts torque at `maxRpm`. Idle holds `idleRpm`
  with throttle. `running: false` gives no torque; a manual with `stall: true` stops the engine
  when clutch-engaged rpm falls below `stallRpm`.
- **Clutch.** Capacity `clutchTorque × engagement`. The engine, clutch, gearbox, differentials and
  wheels are solved implicitly each substep, as PhysX does: an explicit clutch spring stiff enough
  to feel locked goes unstable at 240 Hz once it's reflected through first gear. A slipping clutch
  passes its capacity; a locked one couples the inertias. `auto` engages with rpm above idle
  (launches), opens during shifts and below idle; `pedal` reads `clutch` input.
- **Gearbox.** Ratio `gears[g] × finalDrive` (reverse negative), `efficiency` on drive torque.
  Shifts take `shiftTime` in neutral. Automatic: upshift above `upshift × maxRpm`, downshift below
  `downshift × maxRpm`, both scaled together with throttle so light throttle shifts early without
  falling under the next gear's downshift line; kickdown on a throttle stab; at least 0.5 s between
  shifts, none while airborne or while driven wheels spin past their peak. Validation checks
  `upshift × gears[g+1] / gears[g] > downshift + 0.05` for every pair (`vehicle/bad-gears`), the
  hunting Chaos users report. Manual: `shift` steps, `gear` selects (H-pattern).
- **Differentials.** Open splits torque equally. Locked solves both wheels to one speed in the
  implicit solve. Limited-slip is open plus a locking torque toward the slower side of at most
  `preload + T_in (torqueBias − 1) / (torqueBias + 1)`, so neither side gets more than `torqueBias`
  times the other. `preload` is what drives a car with one wheel in the air or a ditch, where a
  pure torque-bias diff acts open. The center diff splits between axles by `drive` the same way.

### Assists

- **ABS** keeps braking wheels' `κ` near the peak by scaling brake torque per wheel. **TCS** cuts
  throttle while a driven wheel's `κ` passes its peak, and brakes a driven wheel that spins faster
  than its partner (a brake-based limited slip, which is what gets an open-diff car out of mud).
- **ESC** compares yaw rate with the reference `v δ / (L (1 + K v²))` (`K`: `understeer`, measured
  by `vehicle test` when 0), capped by `μ g / v`, outside a deadband. Past it, it brakes one wheel
  (outer front against oversteer, inner rear against understeer) and cuts throttle. A neutral-steer
  reference would read every corner of an understeering car as understeer and brake all the time.
- **Drift:** `driftGrip` scales rear lateral peak while the handbrake is held, `counterSteer` steers
  into the slide, `driftHold` damps yaw past 45° and keeps forward speed.
- **Rollover:** low center of mass, `forceHeight` and anti-roll do most of it; `antiFlip` damps
  roll rate while wheels are grounded. `selfRight` turns an upside-down, slow car upright after 2 s.
- Presets: `sim` (abs 1, tcs 0.5, esc 0, rest 0); `arcade` (abs 1, tcs 1, esc 0.6, counterSteer
  0.5, driftGrip 0.6, driftHold 0.5, downforce 2, airControl, selfRight, antiFlip 0.5).

### Visuals, effects and audio

- **Wheels.** In `PostUpdate`, each wheel's `visual` gets its hardpoint minus suspension travel,
  steer about the axis, camber, and spin `angle`, interpolated by `FixedTime.alpha`. Sinkage
  lowers it.
- **Effects** (`@aethervtt/shard-vehicle/effects`): `VehicleEffects { surfaces: list({ surface,
  particles, tracks }), smoke, skidMarks, skid, track: { lifetime, color, width } }`. Per wheel, the
  ground's particles follow its rolling speed and slip (0026), smoke follows sliding where the
  ground has no particles of its own, and a trail (0082) draws skid marks above `skid` and tracks
  on surfaces with `tracks`.
- **Audio** (`@aethervtt/shard-vehicle/audio`): `VehicleAudio { engine, tires, shift, backfire,
  bottomOut, hit, land, start, stop, stall: handle('AudioEvent') }`. `engine` is a sustain event
  at the chassis with parameters `rpm`, `load`, `throttle`, `gear` and `vehicleSpeed` (on-load
  and off-load loops crossfade on `load` in the authored event, 0077). `tires` is one sustain event
  per wheel with `slip` (skid), `rollSpeed`, `sinkage` and a labeled `surface` switch, so rolling
  and skid loops change with the ground. One-shots with values get `impact` (bottom-out, land,
  hit) and `airTime` (land). An event gets only the parameters it declares; `speed` and
  `distance` are the audio runtime's own listener inputs. One-shots play on the events below. Inaudible voices virtualize.
- **Events:** `VehicleShiftEvent { vehicle, from, to }`, `VehicleEngineEvent { vehicle, kind:
  'started' | 'stopped' | 'stalled' | 'backfire' }`, `VehicleWheelEvent { wheel, kind: 'bottom-out'
  | 'surface', speed, surface }`, `VehicleLandedEvent { vehicle, airTime, speed }`,
  `VehicleHitEvent { vehicle, other, point, normal, speed, character }`, `VehicleSeatEvent {
  vehicle, seat, character, kind: 'entered' | 'exited' }`.

### Characters, seats

- Chassis colliders set `Collider.ignoreCharacters`: contacts with character capsules are detected
  (a character can't walk through a car) but not solved (a capsule never stops or lifts it). Each
  step the chassis' contact pairs name the characters touching it; one that just started touching
  and closes faster than `VehicleConfig.hitSpeed` exchanges momentum by mass: the car loses
  `v_n × m_c / (m_v + m_c)` along the normal and `VehicleHitEvent` reports the hit for the game to
  `hit(… { launch })` (0117). Seated (suspended) characters aren't hit. A horde slows a car in
  proportion to its mass, with no solved contacts.
- `enterVehicle(world, character, seat)` disables the character's controller, parents it to the
  seat and sets `occupant`; the driver's input map writes `VehicleInput`. `exitVehicle` places the
  character at the first clear spot of `exit`, its mirror, or the roof (an overlap test).

### Multiplayer

- **No driver:** the server simulates the vehicle like any dynamic body (0087 replicates it).
- **A driver:** `setDriver(world, vehicle, peer)` sets `Replicated.owner`. That client simulates
  the vehicle (`net/OwnerSimulated` keeps replication from writing it while it owns it) and sends
  its state (pose, velocities, rpm, gear, steer, throttle, load) as a `vehicle/Drive` net command
  (0089) each network tick. The server checks it — speed within `1.25 ×` the vehicle's top speed
  plus 3 m/s, acceleration under `maxAccel`, distance consistent with the time, and a ball swept
  from the last pose clear of its fixed colliders — then writes it to its copy, which replicates
  to everyone else. A failed check rejects the command (`vehicle/rejected`), gives the vehicle to
  the server for `lockout` (1 s) and back after; meanwhile the driver's client follows the server.
- **Who simulates:** on each machine a vehicle's body is dynamic where it simulates it and
  kinematic elsewhere (`VehicleSims.simulates`). Presented vehicles run probes only: wheels follow
  the ground, spin with it and take steer, rpm and gear from the replicated `VehicleState`.
- Hits are reported on the server from its copy's contacts; the driving client applies the
  momentum loss and plays effects immediately.

### Agent surface

- Components in the catalog with units; `Tire` and `Surface` schemas.
- **Protocol:** `vehicle.describe` (each vehicle's state and its wheels'), `vehicle.test`.
- **CLI:** `shard vehicle gen <model> --class sedan|pickup|truck|van|sports|bus` finds the wheel
  nodes (by name, else the lowest round meshes), measures radius and width, groups axles, fits a
  convex hull to the body and writes a prefab with the class's mass, center of mass, torque curve
  and gears. `shard vehicle test <prefab> [--surface s] [--maneuver …] --json` runs headless on a
  flat plane and reports 0–100 km/h, top speed per gear, 100–0 braking distance, skidpad lateral g,
  step-steer peak drift angle and whether it spun or rolled, and the steepest grade it climbs.
- **Overlay** `vehicles`: probes, suspension (green to red), contacts, tire force vectors colored by
  friction use, center of mass, steer angles.
- **Errors:** `vehicle/not-dynamic`, `vehicle/no-wheels`, `vehicle/bad-axle`, `vehicle/bad-curve`
  (torque curve rpm not increasing), `vehicle/bad-gears` (ratios not descending, or shift points
  that hunt), `vehicle/bad-sprung-mass`, `physics/unknown-surface`.
- Skill `add-vehicle.md`: gen, tune against `vehicle test`, surfaces, a driving gameplay test.

## Decisions

- **Own wheel model, not Rapier's controller.** It has two friction scalars, no wheel spin, no
  drivetrain and no surfaces. It's open source, but forking Rapier's Rust to add them is a fork to
  maintain across releases; in TypeScript it's ours and testable headless. Rapier still does the
  chassis, the queries and the solve.
- **Wheels are queries, not bodies.** Every engine above does this; wheel bodies on joints jitter
  at game step sizes and cost a body each.
- **Slip curves with three numbers, not Pacejka coefficients.** `peakSlip`, `slideSlip` and
  `slide` per axis are Unity's extremum and asymptote with the peak normalized, and PhysX's
  three-point curve. An agent can tune them against `vehicle test`; Pacejka's B, C, D, E don't map
  to anything a designer says.
- **Impulse-capped friction, iterated.** Rapier's solver can't take wheel constraints, so the cap
  stands in for Jolt's in-solver friction: each impulse stops at the one that zeroes slip, with the
  wheel's inertia in the effective mass, over a few passes. PhysX shows a slip model also works at
  60 Hz with floored denominators and a sticky mode; the cap keeps a stiff curve from overshooting.
- **Substep the drivetrain, not physics.** Wheel spin and the clutch are the stiff parts and cost
  arithmetic; the chassis velocity is integrated locally inside the substeps, and Rapier steps once.
- **The authored wheel position is ride height.** Models draw wheels where they sit parked; solving
  rest length from sprung mass avoids Unity's `targetPosition` fudging.
- **Surface is physics data.** Colliders and terrain layers own it, footsteps can reuse it, and
  vehicles only read it. Terrain registers a resolver; nothing registers on import.
- **Characters are hit, not collided.** A kinematic controller has infinite mass in the solver, so
  a car would stop dead or climb a zombie; a horde as contact manifolds is also the most expensive
  thing a step could do.
- **The driver's client has authority.** A steering delay of a round trip is unplayable. Rapier
  can't re-simulate one body, only snapshot and restore the whole world; Rocket League predicts and
  re-simulates its whole world at 120 Hz because that world is six cars and a ball, but a
  correction here costs bodies × re-simulated ticks with a horde and ragdolls in it. Server checks
  bound the cheating. A predicted, server-authoritative mode (likely a small separate prediction
  world holding the vehicle and the statics near it) waits for a rollback spec.
- **Audio, effects and seats are subpath plugins.** A headless server loads the simulation only.

## Acceptance criteria

- [x] A 1,500 kg sedan dropped from 0.5 m settles with every wheel within 1 cm of its ride height
      within 1.5 s and its chassis sleeps within 3 s.
- [x] Parked on a 20% grade with the handbrake, it moves less than 1 cm in 10 s.
- [x] At 0.5 m/s with no input on flat ground, wheel spin never changes sign while the car rolls
      to a stop, and lateral chassis speed stays under 1 mm/s. Coasting at 1 m/s, the car
      decelerates at under 0.1 g (standstill doesn't grab early).
- [x] Rev-limited top speed in gears 1–3 (aero drag off) is `maxRpm · 2π r / (60 · ratio ·
      finalDrive)` within 2%.
- [x] 100–0 km/h with ABS on asphalt stops within 10% of `v² / 2 μ g`; without ABS the locked
      wheels slide at least 15% further, and under full steer the heading holds within 2°.
- [x] Skidpad with a grip-1 tire holds 0.8 to 1.0 g; on ice (grip 0.1) braking from 30 km/h
      decelerates at under a seventh of asphalt's.
- [x] Coasting from 40 km/h, a car stops in under a quarter of asphalt's roll-out distance on sand.
      A 2WD car at full throttle in mud for 3 s digs its driven wheels to at least 80% of
      `maxSinkage` and moves under 1 m; with locked center and axle diffs at half throttle, a 4WD
      drives out (over 10 m in 10 s). An open-diff 2WD with its left wheels on ice and right on
      asphalt moves off with `tcs: 1` and with a `preload` limited-slip, three times further than
      with neither, which barely moves.
- [x] Step steer at 100 km/h, a `sedan`-class car with `sim` assists plus `esc: 1` neither spins
      (drift angle under 15°) nor lifts two wheels; with `esc: 0`, the center of mass raised 0.6 m
      and `forceHeight: 0`, it rolls.
- [x] ESC with a measured `understeer` brakes no wheel through a steady 0.5 g corner.
- [x] Arcade preset: handbrake at 60 km/h, then a driver steering toward 30° keeps a 20–45° drift
      for 2 s.
- [x] The automatic gearbox upshifts through every gear in full- and half-throttle runs, never
      shifts down before the next upshift, and steps down under braking. A manual with
      `stall: true` stalls when stopped in gear with the clutch released.
- [x] A car at 10 m/s through a 70 kg character loses `70/1570` of its speed within 2% and emits one
      `VehicleHitEvent` with speed over 9 m/s.
- [x] A rolling wheel's visual angle equals distance over radius within 1%; a visual whose origin
      isn't at its hub turns about the hub.
- [x] Headless voices: the engine event's `rpm` equals `VehicleState.rpm` every frame; a shift plays
      a shift event; locked wheels on asphalt open the skid gate; gravel switches `surface`.
- [x] Effects: dust and tracks on gravel; smoke and skid marks where locked wheels slide on asphalt.
- [x] Two headless runs of 600 frames of arcade driving give the same pose, rpm, gear and speed.
- [x] Two clients at 80 ms (net harness, as `run --net`): client A drives a 12 s circle, client B
      stays within the distance its interpolation delay covers (plus 1 m), and a forged state at
      3× top speed is rejected, the server keeps the vehicle for a second, A follows it, and A gets
      it back.
- [x] `shard vehicle gen` on the fixture car finds 4 wheels with radii within 2 cm, and its prefab
      completes every `vehicle test` maneuver (CLI and in-process).
- [x] Budgets (`pnpm bench`): `vehicle/step-32`, 32 driven vehicles (cylinder probes, 4 substeps)
      within 1 ms; `vehicle/parked-1000`, 1,000 parked vehicles within 0.25 ms.

## As built

- **Package:** `packages/vehicle`: `components.ts`, `tire.ts` (Tire, presets, the grip curve),
  `classes.ts` (sedan, sports, pickup, offroad, van, truck, bus), `sim.ts` (the step: controls and
  gearbox, ground, the substep solver, finish; presented vehicles), `plugin.ts` (build, Rapier
  probes, the step system, wheel visuals), `sims.ts`, `spawn.ts` (`spawnVehicle`), `seats.ts`,
  `maneuvers.ts`, `template.ts` (capture a vehicle, read a prefab, spawn a copy), `methods.ts`,
  `overlay.ts`, `gen.ts`, `ground.ts`; subpaths `./audio`, `./effects`, `./net`, `./testing`.
- **Physics:** `Mass.center | centerOfMass | inertiaScale` (authored: colliders weigh nothing and
  the body takes the whole mass, center and scaled inertia); Mass changes re-apply in sync-in.
  `Collider.surface` and `ignoreCharacters` (solver groups: characters' capsules are members of
  `CHARACTER_SOLVER_GROUP`). `Surface` with ten presets, `Surfaces` (registry by index, resolvers,
  collider cache), `RoadConditions`. `PhysicsWorld.addStepForce` (one step's force and torque,
  cleared in sync-in) and `applyImpulseAtPoint`; `physicsStep` exported for ordering; `cylinder`
  query shapes.
- **Terrain:** a layer's `surface` in the source (else the preset named like the layer; soil and
  earth are dirt, rock and stone concrete, road and tarmac asphalt, beach sand), and a resolver
  reading the two layers of the control texel under a collider tile's contact.
- **Net:** `OwnerSimulated`: a client skips replication into an entity it owns and simulates.
- **Project, CLI:** built-in plugins `vehicle`, `vehicle/audio`, `vehicle/effects` (implying
  physics3d, audio/events, particles); the `add-vehicle` skill; `shard vehicle gen|test`.
- **Playground:** `#vehicles` with seven scenarios (`?scenario=` proving, surfaces, hills, drift,
  offroad, horde, garage), a chase camera, synthesized engine and tire sounds, dust, smoke and
  tracks, the overlay, assists and rain toggles, and `T` to run `vehicle test` on the car.
- **Changes from the design:**
  - **Velocity goes to Rapier as a one-step force,** not impulses or a velocity write: Rapier's
    solver substeps its step, so a velocity written before it leaves a resting car with a phantom
    sink speed and the damper holds it 5 mm off its ride height.
  - **The suspension force is computed once per step** (the position is held over the substeps).
  - **Tires are soft constraints:** under the friction-ellipse bound the tire is a constraint with
    the curve's initial slope as stiffness, solved implicitly. The explicit slip → force loop rang
    near the peak (its time constant is under a substep). Past the peak, friction opposes the slip
    velocity itself, so a locked steered wheel doesn't steer.
  - **Pinned wheels:** a wheel the brakes hold against all the tire and clutch can do is pinned at
    zero spin, and ABS pins a wheel that would lock at 90% of peak slip; the tire then works on the
    chassis alone. With three passes a free light wheel crept, and slip-feedback ABS fell to 0.5 g
    at low speed.
  - **Probes are a ray plus a cylinder:** the cylinder is taken only when it touches clearly sooner
    and higher than the ground under the hub (a curb). Casts against very large boxes lose
    precision in Rapier.
  - **Drivetrain:** the auto clutch is a fluid coupling (capacity grows with the square of the
    engine's rise over idle) and opens under braking; automatic and auto-clutch shifts cut the
    throttle, match revs and re-engage over 0.15 s; shift decisions use the driven wheels' speed.
    A torque converter's multiplication isn't modelled, so a quarter throttle doesn't pull a 4WD
    out of mud: the criterion is half throttle.
  - **Mud and sand** add a rut resistance (`0.6 × sinkage / radius × load`) that holds at a
    standstill, so a dug-in car is stuck rather than slow.
  - **Arcade drifts:** TCS and ESC stand down for 2 s after a handbrake pull; `driftGrip` also
    applies while sliding on the throttle, fading from 30° to 50°; the handbrake flicks the car
    toward the steer; yaw damping grows past 35°.
  - **Audio parameters** are `vehicleSpeed` and `rollSpeed`, not `speed` (reserved by 0077).
  - **Networking uses net commands (0089):** 0088's net inputs and smoothing aren't built. A
    correction shows as interpolation toward the server's pose, not a decaying offset.
  - **Wheel visuals** turn about the hub wherever the visual's origin is, and `visualName` finds a
    model node under the chassis by its instance path.
  - **`vehicle gen`** reads node bounds from the glTF's POSITION accessors, so it needs no asset
    import; `vehicle test` reads the prefab's components and runs on a copy in a fresh app.
- **Measured** on an Apple M5 Max (2026-11-14, not a named machine): 0–100 km/h in 11.5 s, ABS
  100–0 in 40.0 m (39.3 m ideal), locked wheels 52.5 m, skidpad 0.88–0.91 g, top speed 193 km/h
  (sedan); `vehicle/step-32` 0.79–0.94 ms, `vehicle/parked-1000` 0.16–0.19 ms.
- **Not built:** allocation-free stepping isn't checked: Rapier's bindings allocate a result per
  probe and per velocity read (0028's note), and a GC-count check can't tell those apart. Tire
  tracks are 0082's camera-facing ribbons; flat ground-aligned tracks need a ribbon mode there.

## Open questions

- None blocking. Deferred: motorcycles and tracks (their own spec, on this drivetrain); a vehicle
  driven out of its generated cell (0113 makes it a cell delta or a game-added source); a rollback
  spec for server-authoritative predicted vehicles.
