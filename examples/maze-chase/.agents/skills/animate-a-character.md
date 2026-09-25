# Animate a character with a graph

A graph (`*.animgraph.json`) picks the character's clips from parameters: states, transitions
with conditions, blend spaces, and masked layers. It writes the `animation/AnimationPlayer`
layers each frame, so everything the player does (masks, root motion, events) still works.

1. Import the model (`assets/hero.glb`); `get_asset` lists its `#Animation/...` clips.
2. Write `data/hero.animgraph.json` (schema `.shard/schemas/animgraph.schema.json`):

```json
{ "parameters": {
    "speed": { "type": "float", "bind": { "component": "physics/CharacterState", "field": "velocity", "op": "horizontal" } },
    "grounded": { "type": "bool", "bind": { "component": "physics/CharacterState", "field": "grounded" } },
    "attack": { "type": "trigger" } },
  "layers": [
    { "name": "base", "entry": "locomotion",
      "states": {
        "locomotion": { "blend1d": { "parameter": "speed", "clips": [[0, "#idle"], [1.5, "#walk"], [5, "#run"]] } },
        "fall": { "clip": "#fall" },
        "land": { "clip": "#land", "loop": "once" } },
      "transitions": [
        { "from": "locomotion", "to": "fall", "when": "!grounded", "duration": 0.15 },
        { "from": "fall", "to": "land", "when": "grounded", "duration": 0.05 },
        { "from": "land", "to": "locomotion", "exitTime": 0.8, "duration": 0.2 } ] },
    { "name": "upper", "mask": { "path": "data/masks/upper-body.mask.json" },
      "states": { "none": {}, "swing": { "clip": "#swing", "loop": "once" } },
      "transitions": [
        { "from": "none", "to": "swing", "when": "attack", "duration": 0.1 },
        { "from": "swing", "to": "none", "exitTime": 1, "duration": 0.2 } ] } ],
  "clips": {
    "idle": { "path": "assets/hero.glb#Animation/Idle" }, "walk": { "path": "assets/hero.glb#Animation/Walk" },
    "run": { "path": "assets/hero.glb#Animation/Run" }, "fall": { "path": "assets/hero.glb#Animation/Fall" },
    "land": { "path": "assets/hero.glb#Animation/Land" }, "swing": { "path": "assets/hero.glb#Animation/Swing" } } }
```

3. Put `"animation/Animator": { "graph": { "path": "data/hero.animgraph.json" } }` on the model
   root (next to its AnimationPlayer). Bound parameters read the component on that entity or its
   nearest ancestor, so a model under a `physics/CharacterController` entity finds its state.
4. `shard validate --json`: unknown states, clips, or parameters and conditions that don't parse
   are errors with a pointer (conditions give the column); unreachable states are warnings.

- Conditions: parameter names, numbers, `true`/`false`, `!`, `&&`, `||`, `< <= > >= == !=`,
  parentheses. Transitions are checked in order, first match wins; `"from": "*"` is any state.
  `exitTime` waits for the source state's normalized time (1 = its end); `duration` crossfades.
- Triggers stay true until a transition that reads them is taken. Set parameters in code with
  `setAnimParam(world, entity, 'attack', true)`, or patch `animation/AnimatorParams.values`.
- `{}` states play nothing: the layers below show through. `blend1d` syncs its clips' normalized
  times; `blend2d` (`"x"`, `"y"`, `"clips": [[x, y, "#clip"], ...]`) weights the three nearest
  samples. Bind ops: `value`, `length`, `horizontal` (xz), `x`, `y`, `z`, `not`.
- `animation/AnimatorStateEntered` (`entity`, `layer`, `state`, `from`) fires on each entry, for
  "landed" or "swing hit". `animation_describe` shows each layer's state, transition progress,
  time in state, blend weights, and the parameters.

```ts
test('the hero falls, lands, and walks', async ({ game }) => {
  await game.load('scenes/main.scene.json')
  const layer = async () =>
    (await game.call<any>('animation.describe', { entity: 'hero/model' })).animator.layers[0]
  await game.step(30)
  expect((await layer()).state).toBe('locomotion')
  await game.patch('hero', { 'core/Transform': { translation: [0, 5, 0] } })
  await game.step(10)
  expect((await layer()).state).toBe('fall')
  await game.patch('hero', { 'physics/CharacterIntent': { move: [0, 0, -3] } })
  await game.step(120) // lands, then walks at 3 m/s: between walk (1.5) and run (5)
  const base = await layer()
  expect(base.state).toBe('locomotion')
  expect(base.active.at(-1).motions.find((m: any) => m.name === 'Walk').weight).toBeGreaterThan(0.5)
})
```
