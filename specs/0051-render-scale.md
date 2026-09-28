# 0051 — Render scale and dynamic resolution

- **Status:** implemented
- **Packages:** `@aethervtt/shard-runtime`, `@aethervtt/shard-gpu`, `@aethervtt/shard-render`, `@aethervtt/shard-terrain`, `@aethervtt/shard-ui`, `@aethervtt/shard-text`, `@aethervtt/shard-sprite`
- **Depends on:** 0005, 0007, 0021, 0023, 0044

## Context

The window's canvas is backed at `clientWidth × devicePixelRatio`, and every `'view'`-sized graph
texture follows it. A Retina Mac reports a ratio of 2, so the G-buffer, deferred lighting, the
atmosphere's per-pixel march, and post all shade four times the pixels of the CSS size: a 16"
MacBook Pro window is about 3456×2234, 7.7 million pixels a frame. Sprite scenes don't notice;
terrain under an atmosphere does, and that's the proof project.

Lowering the canvas resolution fixes the cost but blurs UI and text with it. Engines split the
two: the scene renders at a *render resolution*, is upscaled once to the *display resolution*, and
UI draws on top at full resolution. The render resolution is then free to follow the GPU's
headroom (dynamic resolution): a strong GPU stays native, a weak one drops just enough to hold the
frame budget.

## Goals

- A render scale for camera views that show on the window: the scene renders at
  `round(target × scale)` and is upscaled, with light contrast-adaptive sharpening, onto the target.
- Screen-space sprites, screen text, and UI draw at display resolution after the upscale.
- `auto` mode: a controller moves the scale between `min` and `max` to hold a frame budget, from
  GPU frame time (`timestamp-query`) or, without it, the frame interval. The budget is one refresh
  of the display by default, so a 120 Hz screen is held at 120 fps, not 60.
- `DisplayRate`: the display's refresh rate as an engine resource any system can read, measured by
  the frame runner in about 0.1 s at startup.
- `fixed` mode: a set scale, for settings menus and measurements.
- Pixel thresholds meant for the eye are measured in CSS pixels, so a Retina display doesn't pay
  for detail nobody can see: terrain LOD (`errorPixels`, `vertexPixels`), and the default MSAA,
  which is skipped on displays of 1.5 pixels per CSS pixel or more.
- Offscreen targets, screenshots, headless runs, and tests are unaffected (scale 1), so golden
  images and world hashes don't change.

## Non-goals

- Temporal upscaling (TAA-U / FSR 2 style). TAA keeps working at the render resolution; feeding
  it the display resolution is a later spec.
- Per-camera scales. One setting for every window camera.
- Scaling gizmo line widths and labels, which draw into the scene at render resolution.

## Design

### Render resolution vs display resolution

`RenderView` gains optional `width`/`height`: the size `'view'`-sized textures (and divisors of it)
get. Unset means the target's size. `view-target` is always the target itself.

`CameraData.width/height` is the render resolution; `displayWidth/displayHeight` is the target's.
Everything up to `Display` uses the former; overlay passes (screen sprites, screen text, UI) use
the latter.

### The display stage

The graph's last scene image is a new resource, `display` (format `'view'`, render size):

```
tonemap → ldr ─(FXAA)→ display ─(upscale)→ view-target → overlays
```

Unscaled views alias `display → view-target` (and `ldr → view-target` without FXAA, as before), so
they run exactly the same passes as today. Scaled views alias `ldr → display` and enable
`post/upscale` (phase `Display + 10`), which samples `display` bilinearly into `view-target`. The
sharpening is a clamped unsharp mask over the four neighbors, so it can't ring past the local
min/max.

Pixel-perfect cameras keep their own integer upscale and aren't scaled. Neither are cameras that
render to a render-target asset.

### Display density

`GpuContext.pixelRatio` records `devicePixelRatio` at each resize, and `RenderTarget.pixelRatio`
exposes it: the window's is the display's, offscreen targets default to 1 (a test can pass 2).
Extraction copies it to `CameraData.pixelRatio`.

- **Terrain LOD** projects errors against `displayHeight / pixelRatio`, the view's height in CSS
  pixels. Measured in device pixels, the playground planet selected 999 chunks at 500 m on a 2×
  display (2560×1600) instead of 501, and its frame cost 23 ms of GPU instead of 15. The CSS
  height also doesn't change with the render scale, which would otherwise feed back into the
  controller (lower scale → fewer chunks → cheaper → higher scale → more chunks).
- **Default MSAA.** A forward camera without an `Antialiasing` component uses `ViewSettings.msaa`
  (4) unless its display is at least `ViewSettings.msaaMaxPixelRatio` (1.5) dense; then 1. At 2×,
  the pixels are too small for stair steps to show, and the 4 samples cost about a third of the
  frame (18.6 → 13.3 ms in the same view). The test is on the display's density, not the render
  resolution, so the controller can't flip it. `msaaMaxPixelRatio: 0` restores MSAA everywhere,
  and an `Antialiasing` component always wins.

### Display rate

`DisplayRate` (`@aethervtt/shard-runtime`) is `{ hz, periodMs, source }`, inserted by the time plugin at an
assumed 60 Hz, so headless runs see a fixed value. Before its first update, `animationFrameRunner`
times 12 idle `requestAnimationFrame` intervals (0.1 s at 120 Hz, 0.2 s at 60), takes the median,
and snaps it to the nearest shipping rate within 4% (60, 75, 90, 120, 144, 165, 240…).
`measureRefresh: false` skips the probe.

After that, only faster frames count. An app that can't keep up shows longer intervals than the
display's, so slow frames say nothing about it. A run of 20 intervals under 85% of the period
(the window moved to a faster screen, or ProMotion left an idle rate) raises the rate. Moving to a
slower screen isn't detected; the budget then stays shorter than the screen needs, which costs
resolution but never frames.

### Controller

`render/update-render-scale` runs in `RenderSet.Extract`, before `extractCameras`. It only acts
while a camera shows on a window target. It skips frames that compile pipelines or are hitches
(delta ≥ 0.2 s), and waits a cooldown after every change so it only ever measures the new size.

The budget (`budgetMs`) is `targetMs` when set. When it's 0 (the default), the budget is one
display refresh, but no shorter than `1000 / maxHz` (144 Hz): past that, holding the rate would
cost more resolution than the extra frames are worth. A frame that misses a 120 Hz refresh by
0.7 ms shows for two refreshes, so a 9 ms scene on a 120 Hz Mac swings between 60 and 120 fps
against a 16.7 ms budget that says it's fine. Against 8.3 ms, the controller settles at 0.9.

- **GPU time** (`gpu:frame` from the timer): an EMA of the frame's GPU span. Cost is proportional
  to pixels, so over `0.95 × budget` the scale drops to `scale × √(0.8 × budget / ema)` right
  away. It rises when the cost predicted one step up, `ema × ((scale + 0.05) / scale)²`, stays
  under `0.8 × budget` for a second: toward `√(0.8 × budget / ema)`, at most 0.1 at a time. The
  scale it lands on sits under 80% of the budget, clear of the drop threshold, so rising can't start
  an oscillation, and a view that gets cheaper always brings it back to `max`.
- **Frame interval** (no timestamps, e.g. some WebKit builds): only overruns are visible, since
  vsync hides headroom, and the interval moves in whole refresh periods, so one drop often shows
  nothing. Over `1.15 × budget` it drops 0.1 at a time. Drops count as one run: if the run
  halves the pixels (scale × 0.71) or reaches `min` without the frame getting 5% shorter, the frame
  is CPU-bound. Halving a GPU-bound frame's cost always saves at least one refresh period, so the
  run is undone, and overruns no worse than that one are left alone. At budget for 3 s it probes
  one step up. A probe that overruns is undone, and the next probe waits twice as long (up to 30 s).

Scales snap to steps of 0.05, so the texture pool sees few distinct sizes; unused sizes expire
after 60 frames as with any resize.

### API sketch

```ts
world.resource(RenderScale) // { mode: 'auto', scale: 1, min: 0.5, max: 1, targetMs: 0, maxHz: 144, sharpen: 0.25 }
world.resource(DisplayRate) // { hz: 120, periodMs: 8.33, source: 'measured' }
world.patchResource(RenderScale, { mode: 'fixed', scale: 0.75 }) // from host code (0052)

forwardPlugin({ renderScale: { mode: 'fixed', scale: 0.8 } })
```

### Agent surface

- `render.describe` → `renderScale`: mode, current scale, bounds, target, the signal the controller
  uses (`gpu`/`frame`/`none`), its measured ms, and each scaled view's render and display size.
  `views[].size` stays the target size; `views[].renderSize` is added.
- `resource.set` on `render/RenderScale` changes the mode, bounds, or fixed scale.

## Decisions

- **One view, two resolutions**, not pixel-perfect's second view: the camera's own overlays stay
  on the camera's view, and the post chain needs no second target.
- **Upscale in display space (after tonemap and FXAA)**, like FSR 1: the filter works on perceptual
  values, and FXAA runs on the smaller image.
- **`auto` by default** with `max: 1`: native resolution whenever the GPU keeps up. A ceiling above
  1 supersamples, and is allowed.
- **Square-root step from GPU time.** GPU cost follows pixel count, which follows `scale²`, so one
  step lands close to the budget instead of creeping.

## Acceptance criteria

- [x] A window camera at scale 0.5 renders its scene textures at half size and `view-target` at full.
- [x] Scale 1, offscreen targets, and pixel-perfect cameras run the same nodes as before.
- [x] Screen sprites, screen text, and UI get the display size in their view uniforms.
- [x] Picking maps target pixel coordinates to the render resolution.
- [x] The controller drops on GPU overrun, rises on sustained headroom, snaps to 0.05, respects
      `min`/`max`, and stays put in `fixed` mode.
- [x] The frame-interval fallback undoes a run of drops that didn't help (CPU-bound), once.
- [x] `render.describe` reports the scale, the budget and display rate, and each view's render size.
- [x] Refresh rates snap to shipping rates, a probe reads through hitches, and only runs of faster
      frames raise the rate.
- [x] With `targetMs` 0 the budget is one display refresh (8.3 ms at 120 Hz), capped at `maxHz`, and
      the scale returns to `max` when the view gets cheaper.
- [x] A 2× target selects the same terrain chunks as a 1× target of the same CSS size.
- [x] The default MSAA is 4 at 1× and 1 at 2×; an Antialiasing component or
      `msaaMaxPixelRatio: 0` keeps it.

## Open questions

- A floor in physical density (for example, never below 1 render pixel per CSS pixel unless
  `min` allows it) might be a better bound than a fraction of the backing size.
