# 0052 — Embedding: transparent surfaces, shared devices, on-demand frames, teardown

- **Status:** implemented
- **Packages:** `@aethervtt/shard-gpu`, `@aethervtt/shard-render`, `@aethervtt/shard-runtime`, `@aethervtt/shard-core`, `@aethervtt/shard-particles`, `@aethervtt/shard-physics`, `@aethervtt/shard-animation`, `@aethervtt/shard-input`, `@aethervtt/shard-assets`, `@aethervtt/shard-protocol`
- **Depends on:** 0003, 0005, 0007, 0019, 0023, 0051

## Context

Shard assumes it owns the page: one opaque canvas, one app, a frame every `requestAnimationFrame`,
and nothing to clean up because the tab closes. A host application embedding Shard breaks each
assumption. Aether, a VTT, puts a fullscreen transparent dice canvas above its whole interface
(chat, panels, dialogs), with the table renderer underneath it. Both mount and unmount with the
session, and the dice canvas is idle almost all the time.

Before this spec the canvas was configured `alphaMode: 'opaque'`, and tonemap, FXAA, TAA and
upscale all wrote alpha 1. An `App` couldn't be disposed, and a second app on the page got its own
GPU device. An idle scene still rendered 60 or 120 frames a second.

This spec makes Shard a good guest: transparent output, several canvases on one device, frames
only when something changed, and a complete teardown.

## Goals

- `alpha: 'premultiplied'` surfaces whose pixels composite correctly over the DOM, including glow.
- Alpha preserved through every graph pass, with a clear alpha of 0 meaning "show the page".
- A shadow-catcher material: invisible except for the shadows it receives.
- Several canvases (surfaces) on one `GpuContext`, and several apps sharing it.
- On-demand frames: no `requestAnimationFrame` while nothing changes; host writes wake the app.
- `app.dispose()` releases everything the app created: GPU objects, surfaces, listeners, runners.
- GPU resource accounting, so tests can prove cleanup.

## Non-goals

- Reading or refracting DOM pixels. The browser composites; Shard can't see under its canvas.
- Pointer passthrough. That's CSS (`pointer-events: none`) and stays the host's.
- Offscreen-canvas rendering in a worker. Later.

## Design

### Surfaces and alpha

A surface is a configured canvas:

```ts
const gpu = await createGpuContext()                       // device only
const table = gpu.addSurface(tableCanvas)                   // alpha: 'opaque'
const dice = gpu.addSurface(diceCanvas, { alpha: 'premultiplied' })
```

`createGpuContext({ canvas, alpha })` keeps working and adds one surface. Each surface owns its
`GPUCanvasContext`, resizes from a `ResizeObserver` (device-pixel box where the browser has it, CSS
box × `devicePixelRatio` otherwise; one `clientWidth` read when it's added), tells `onResize`
listeners, and is reconfigured with the same alpha mode after device loss. Adding a canvas twice
throws `gpu/duplicate-surface`. `surface.remove()` calls `unconfigure()` and disconnects the
observer. The surface is the render target: `GpuContext` no longer has `canvas`, `context`,
`resize()` or `pixelRatio`, and `WindowTarget` is gone.

`renderPlugin({ gpu, surface })` renders an app into an existing surface (`gpu` may be omitted: it's
`surface.gpu`; a mismatch throws `render/surface-device`). `renderPlugin({ canvas, alpha })` is the
one-app shorthand, on `gpu` if given, else on a device the plugin makes. Camera targets are
unchanged: `target: null` means the app's surface.

**Alpha through the graph.** Scene color is premultiplied RGBA. The camera's `clearColor` alpha is
the clear alpha, and its color is premultiplied by it. A view clearing below alpha 1 has
`alphaOutput` set on its camera data. Opaque and masked materials write alpha 1 in every view (an
`OPAQUE` define in the forward material modules), whatever their base color's alpha. Blended
materials already blend alpha as premultiplied "over". In an `alphaOutput` view:

- the sky, skybox, atmosphere sky and `DefaultEnvironment` background aren't drawn (the camera's
  environment `background` is -1). IBL lighting still applies.
- **light raises alpha, then the tonemap un-premultiplies.** The tonemap first raises alpha to
  `max(a, min(1, maxRGB))` of the HDR pixel, so additive particles, emissive halos and bloom show
  where coverage is 0; then it divides by that alpha, grades and tonemaps, and premultiplies again
  in display space (the space the page composites in), so output never has `rgb > a`, whose result
  the WebGPU spec leaves to the browser. Dithering is premultiplied too. A glow over a white panel
  still brightens what's under it, but it also slightly occludes it, as a real glow on glass would.
- FXAA and upscale carry alpha and re-apply `a = max(a, maxRGB)` after filtering (sharpening can
  overshoot). TAA resolves alpha like color: history clamped to the neighborhood, blended at the
  same rate. Fog is a layer of its own opacity: `a' = a·T + (1 − T)`. DoF, bloom's composite and
  motion blur already carried alpha. PixelPerfect letterbox bars are transparent.

Opaque views take exactly the old path: the tonemap, FXAA, TAA, fog and upscale compile the alpha
code out with a `TRANSPARENT` define, and nothing in an opaque view reads HDR alpha, so the opaque
materials' alpha 1 doesn't change their output. Golden images don't change.

### Shadow catcher

`ShadowCatcher` (`render/ShadowCatcher`, from `shadowCatcherPlugin`, which `forwardPlugin`
includes) is an unlit, premultiplied material: color 0, alpha `opacity × (1 − visibility)`.
Visibility is the light of every shadow-casting light (directional and clustered point and spot)
reaching the surface with shadows, over that light without them; 1 when no light casts shadows, or
when the mesh has `NotShadowReceiver`. `opacity` defaults to 0.6. Give its mesh `NotShadowCaster`.
The dice tray floor uses it, so shadows fall on the page; over a scene it darkens what's behind it.

### Shared devices across apps

Two apps can share one `GpuContext` (`renderPlugin({ gpu })`). This spec makes that safe:

- per-device objects go through `gpu.shared(key, create)`: made once per device, counted against
  the device (owner `'gpu'`), made again after a loss. The particles' identity buffer and the
  atmosphere's empty textures were module-level caches keyed by `gpu.generation`; the other
  generation-keyed caches were already per world or per device. A test with two apps on one device
  (and the render tests on others) covers the rest.
- global registries are idempotent. Defining a material type again with an equal definition
  returns the existing type; a different definition under the same name throws
  `render/registry-conflict`. Data types do the same with `assets/registry-conflict`, and
  `defineAssetType` throws it for a different store or loader. Inside a hot reload's redefinition
  scope, types still update in place.
- each app's objects are counted under its own owner (below), so one app's `dispose()` never frees
  another's. Apps share one device recreation after a loss (`gpu.recreate()` is shared while in
  flight).

### GPU accounting

`GpuContext` wraps its device's `createBuffer` and `createTexture` and counts every live object
against `gpu.owner`, the owner current when it was made: `gpu.stats(owner?)` →
`{ buffers, textures, bytes }` (bytes over every mip level, 3D slice and sample), `gpu.owners()`,
and `gpu.withOwner(owner, fn)`. Destroying an object uncounts it; so does garbage collection of one
nobody destroyed (a `FinalizationRegistry`). `gpu.release(owner)` destroys what an owner still has.
Swapchain textures aren't counted. Query sets aren't either; the GPU timer destroys its own.

Each render plugin is an owner (`render:<n>` by default, `renderPlugin({ owner })` to name it;
`renderOwner(world)` reads it). It sets `gpu.owner` through an `AppScope`: `app.addScope({ enter,
exit })` runs around everything the app runs (plugin builds, the synchronous part of ready hooks,
frames, pumps, and disposal). Scopes nest, so a preview app rendering inside a frame counts its own
objects. Code after an `await` in a ready hook runs outside the scope and counts against `'gpu'`;
the render plugin wraps its own post-await setup in `withOwner`.

### On-demand frames

`animationFrameRunner({ mode: 'on-demand' })` requests an animation frame only when:

1. the world changed since the last frame. `World` gets `asleep` and one `onWake` callback, set by
   the runner: when a frame ends with nothing asking for another, the runner sets `asleep`, and the
   first `set`, `add`, `remove`, `spawn`, `despawn`, `insertResource`, `removeResource`, `send`,
   `patchResource` or `touchResource` clears it and calls `onWake`. That's one boolean check per
   write, with no allocation. `world.wake()` does the same on purpose: `captureView` and
   `captureBuffer` call it, so a capture renders its frame.
2. something holds a **frame demand** (the `FrameDemand` resource, always present):
   `hold(key)` / `release(key)`, `set(key, on)` for a system tracking a condition each frame,
   `held()` and `isHeld(key)`. Built-in holders: `physics` (awake bodies after a step),
   `particles` (a playing system that spawns, has a burst to come, or has particles within their
   lifetime), `animation` (a playing layer short of a `once` clip's end, or a fade),
   `render/render-scale` (the controller verifying an upward probe), and `render/loading` (a
   frame that skipped draws: pipelines compiling, meshes or materials still loading, so an app
   never stops on a half-drawn first frame). There are no tweens or
   transitions yet; one that runs each frame holds a demand.
3. input arrived (an `InputSource` may offer `onInput(listener)`; the DOM source calls it for every
   event, and the input plugin turns that into `app.requestFrame()`), a surface resized,
   `app.requestFrame()` was called, steps were queued (`AppControl.step`), or a timer asked for a
   frame (`FrameDemand.after(ms)`, for ambient loops at low rates; the earliest ask wins).

**Resource writes are explicit.** `world.resource(R)` returns the object itself, so a bare field
assignment (`world.resource(AmbientLight).brightness = 2000`) is invisible to the world. Two new
calls make it visible, and both also give resources a change tick (`world.resourceChanged(R,
since)`; `insertResource` and `removeResource` set it too), which systems can use like component
change detection:

- `world.patchResource(R, partial)` assigns the fields, marks the resource changed, and wakes;
- `world.touchResource(R)` marks it changed and wakes, after in-place edits.

The rule is that code outside a frame (host code, protocol handlers, UI callbacks) writes
resources only through these, `insertResource`, or plugin setters that call them; or it calls
`app.requestFrame()`. Systems running inside a frame may still assign fields directly, because a
frame is already running. The protocol's `resource.set` uses `patchResource`, and `time.resume`
requests a frame. Every spec that shows a host writing a resource uses these calls.

Resources hosts write are marked with `defineResource(name, { hostWritable: true })`; render marks
`AmbientLight`, `LightingSettings`, `DefaultEnvironment`, `DebugOverlays`, `RenderScale` and
`ViewSettings` (0058's `FogSettings` must be too). With `checkResourceWrites: true` (for dev
builds; the engine has no build flag of its own, so the host turns it on), the on-demand runner
hashes the plain-object hostWritable resources when it goes idle and checks them each second. A
changed hash with no wake logs `runtime/unmarked-resource-write`, naming the resource. The check is
a lazily loaded module, so production bundles don't carry it.

On waking, `Time` clamps the delta to one fixed step and the fixed accumulator resets
(`app.resetFixedTime()`), so a scene idle for a minute doesn't simulate the minute. The display
rate meter only samples consecutive frames. `mode: 'continuous'` (the default) runs as before.
`FrameDemand.mode` says which mode drives the app (`'manual'` without a loop runner).

### Teardown

```ts
await app.dispose()
```

Plugins get an optional `dispose?(app)`, called in reverse build order. The runner stops first
(a loop runner gives the app a `FrameDriver` through `app.attachDriver`, which `requestFrame` and
`dispose` use), then plugins release what they created. A plugin whose dispose throws is logged
and the others still run; the first error is rethrown at the end. `dispose()` is idempotent, and
any other call on a disposed app throws `runtime/disposed`.

- render: unsubscribes its error, device-loss and resize listeners, rejects pending captures,
  destroys the timer's query set, removes its surface (created or passed in), destroys every
  buffer and texture counted against its owner (`gpu.release`), and destroys the device only if
  it made it.
- the runner cancels its animation frame, the refresh probe, its timers and its visibility
  listener, and clears `world.onWake`.
- input disposes its source; physics frees its Rapier world; audio stops its voices (and disposes
  the backend only if it made it: a host's backend may serve another app).
- the asset, particle-effect and clip previews dispose the apps they render with.

### API sketch

```ts
interface SurfaceOptions { alpha?: 'opaque' | 'premultiplied'; label?: string }
class Surface { canvas; alpha; gpu; width; height; texture(); onResize(fn); remove() }
interface GpuContext {
  addSurface(canvas, o?: SurfaceOptions): Surface; readonly surfaces: readonly Surface[]
  stats(owner?: string): GpuStats; owners(): string[]; release(owner: string): number
  withOwner<T>(owner: string, fn: () => T): T; shared<T>(key: string, create: (d: GPUDevice) => T): T
}

renderPlugin({ gpu, surface }) | renderPlugin({ canvas, alpha: 'premultiplied' })
animationFrameRunner({ mode: 'on-demand', signal, checkResourceWrites })
world.resource(FrameDemand).hold('dice/presentation')
world.patchResource(AmbientLight, { brightness: 2000 })
app.requestFrame()
await app.dispose()
```

Test helpers: `fakeAnimationFrames()` (`@aethervtt/shard-runtime/testing`) drives the runner
headless, and `headlessCanvas(w, h)` (`@aethervtt/shard-gpu/node`) is a canvas whose WebGPU
context renders into a texture, so surfaces work in Node.

### Agent surface

- `render.describe` gains `surfaces[]` (label, size, alpha mode, pixel ratio, whether it's this
  app's), `frames: { mode, demands[], dueInMs }`, naming each holder that is keeping frames
  running, and `gpuObjects` (this app's `gpu.stats`). They come from `renderDescribePlugin`.
- `gpu.stats` via the protocol, for one owner or every owner and the total.

## Decisions

- **Clamp to `rgb ≤ a` instead of relying on unclamped premultiplied output.** WebGPU leaves
  `rgb > a` to the implementation, so it would look different across Chrome, Safari and Firefox.
- **Light raises alpha before the tonemap un-premultiplies, not after.** Un-premultiplying light
  over zero coverage divides by zero, and over little coverage makes a glow vanish; raising alpha
  first keeps the result continuous and leaves opaque pixels as they were.
- **Opaque materials write alpha 1 in every view, not only in transparent ones.** Per-view material
  variants would double the pipelines; opaque views never read HDR alpha.
- **One wake callback on `World`, not change polling.** Polling needs a rAF loop, which is the
  thing on-demand mode removes.
- **Surfaces, not multiple devices.** One device lets the dice and table apps share pipelines,
  textures and screen-space effect data (0054's lens fields), and halves the driver memory.
- **Count by the current owner and sweep on dispose.** Plugins don't track every GPU object they
  make; the device's ledger knows what each app made, which proves cleanup and frees it.
- **The write check is opt-in and lazy.** The engine has no dev-build flag, and production apps
  shouldn't carry it.
- **renderer-min grows about 3.4 KB brotli (entry) for this.** Surfaces, accounting, teardown and
  on-demand frames are in every app; `bench/size/budgets.json` records the new size.

## Acceptance criteria

- [x] Headless: a camera clearing to alpha 0 over an offscreen `rgba8unorm` target reads back
      alpha 0 where nothing drew, 1 on an opaque mesh, and the material alpha on a blended one,
      with tonemap, FXAA, TAA and bloom enabled.
- [x] No pixel of a transparent view's output has any channel above its alpha (checked on a scene
      with additive particles and bloom).
- [x] Opaque views render byte-identical golden images before and after this change.
- [x] A shadow catcher under a lit cube reads alpha 0 outside the shadow and `opacity` inside it.
- [x] Two apps on one `GpuContext` render to two surfaces. Disposing one leaves the other's
      `gpu.stats` unchanged and still rendering.
- [x] After `app.dispose()`, `gpu.stats(owner)` is 0, the surface is unconfigured, and no rAF,
      listener or observer remains. 100 create/dispose cycles show no growth.
- [x] On-demand mode: an idle scene requests 0 animation frames over 5 s. A `world.set` from the
      host produces exactly 1 frame. A falling physics body keeps frames running until it sleeps,
      then they stop.
- [x] While idle in on-demand mode, `world.patchResource(AmbientLight, { brightness: 2000 })`
      produces exactly 1 frame, and the scene renders brighter in it. A bare field assignment
      produces no frame, and with `checkResourceWrites` logs `runtime/unmarked-resource-write`
      within 1 s. (Written against `FogSettings`, which arrives with 0058.)
- [x] Device loss on a premultiplied surface restores it as premultiplied.

## Open questions

- ~~Should `FrameDemand.after(ms)` ambient loops pause when `document.hidden`?~~ Yes, and they do
  without code: the timer fires, but the browser runs no animation frames while hidden, so the
  frame waits until the page is visible. The same holds for every demand.
