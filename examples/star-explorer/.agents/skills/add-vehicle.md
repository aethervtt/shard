# Add a vehicle

Add `"vehicle"` to `plugins` in `shard.json` (it brings `physics3d`; `"vehicle/audio"` and
`"vehicle/effects"` add sound and wheel dust, smoke and tracks). Make a prefab from a car model:

```sh
shard vehicle gen assets/car.glb --class sedan     # or sports, pickup, offroad, van, truck, bus
shard vehicle test prefabs/car.prefab.json         # 0–100, braking, skidpad, step steer, climb
```

`gen` finds the wheels (nodes named wheel/tire/tyre, else the lowest round meshes), measures them,
groups axles front (−Z) to back, puts a body box above the axles and writes the class's mass,
center of mass, engine and gears. Each `vehicle/VehicleWheel` names its model node in
`visualName`; the node spins, steers and follows the suspension. Place it with
`scene/PrefabInstance`.

- Drive it by writing `vehicle/VehicleInput`: `throttle`, `brake` (0–1), `steer` (−1 left … 1
  right), `handbrake`; manual gearboxes take `shift` (−1/+1) or `gear`, and `clutch` with
  `VehicleTransmission.clutch: "pedal"`. An automatic reverses when you hold brake at a stop.
- Read `vehicle/VehicleState` (speed m/s, rpm, gear, drift angle, assists acting) and each wheel's
  `vehicle/WheelState` (grounded, compression, surface, slip, skid, sinkage).
- Tune with numbers: `shard vehicle test` (or the `vehicle.test` method) after each change.
  Handling: `VehicleWheel.frequency` and `damping` (suspension), `Vehicle.axles[].antiRoll`,
  `physics/Mass.centerOfMass` (lower is steadier), `forceHeight` (0.3 keeps cars upright),
  tires (`vehicle/road|sport|offroad|winter.tire.json` or your own `*.tire.json`). Assists:
  `vehicle/VehicleAssists` with `preset: "sim"` or `"arcade"` (drifts, air control, self-right).
- Ground: `physics/Collider.surface` (`physics/gravel.surface.json`, sand, mud, snow, ice…), and
  terrain layers named grass, gravel, sand… or with `surface` set. `physics/RoadConditions`
  `wetness` is the weather.
- Get in and out: `enterVehicle(world, character, seat)` and `exitVehicle(world, character)`.
  Hitting a character costs the car its mass share of speed and sends `vehicle/Hit`.
- Look at it: `screenshot` with `"overlays": ["vehicles"]` (probes, tire forces, center of mass);
  `vehicle.describe` for every wheel's numbers.

```ts
test('the car stops in under 45 m from 100 km/h', async ({ game }) => {
  await game.load('scenes/main.scene.json')
  await game.patch('car', { 'vehicle/VehicleInput': { throttle: 1 } })
  await game.step(60 * 14)
  await game.patch('car', { 'vehicle/VehicleInput': { throttle: 0, brake: 1 } })
  await game.step(60 * 4)
  expect(game.get('car', 'vehicle/VehicleState').speed).toBeLessThan(0.5)
})
```
