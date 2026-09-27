# 0052 — Embedding: transparent surfaces, shared devices, on-demand frames, teardown

- **Status:** accepted
- **Packages:** `@shard/gpu`, `@shard/render`, `@shard/runtime`, `@shard/core`, `@shard/particles`
- **Depends on:** 0003, 0005, 0007, 0019, 0023, 0051

## Context

Shard assumes it owns the page: one opaque canvas, one app, a frame every `requestAnimationFrame`,
and nothing to clean up because the tab closes. A host application embedding Shard breaks each
assumption. Aether, a VTT, puts a fullscreen transparent dice canvas above its whole interface
(chat, panels, dialogs), with the table renderer underneath it. Both mount and unmount with the
session, and the dice canvas is idle almost all the time.

Today the canvas is configured `alphaMode: 'opaque'`, and tonemap, FXAA, TAA and upscale all
write alpha 1. An `App` can't be disposed, and a second app on the page gets its own GPU device.
An idle scene still renders 60 or 120 frames a second.

This spec makes Shard a good guest: transparent output, several canvases on one device, frames
only when something changed, and a complete teardown.

## Goals

- `alpha: 'premultiplied'` surfaces whose pixels composite correctly over the DOM, including glow.
- Alpha preserved through every graph pass, with a clear alpha of 0 meaning "show the page".
- A `shadow-catcher` material: invisible except for the shadows it receives.
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

`createGpuContext({ canvas })` keeps working and adds one surface. Each surface owns its
`GPUCanvasContext`, resizes from a `ResizeObserver` (not a per-frame `clientWidth` read), and is
reconfigured with the same alpha mode after device loss. `surface.remove()` calls `unconfigure()`.

`renderPlugin({ gpu, surface })` renders an app into an existing surface. `renderPlugin({ canvas,
alpha })` is the one-app shorthand. Camera targets are unchanged: `target: null` means the app's
surface.

**Alpha through the graph.** Scene color is premultiplied RGBA. The camera's `clearColor` alpha is
the clear alpha. Opaque materials write alpha 1. Blended materials use premultiplied "over"
(`src + dst × (1 − srcA)` for both color and alpha). When a view's clear alpha is below 1:

- the sky, skybox, atmosphere sky and `DefaultEnvironment` background aren't drawn. IBL lighting
  still applies.
- tonemap un-premultiplies, tonemaps, and re-premultiplies; FXAA, TAA, DoF, fog and upscale carry
  alpha. Fog raises alpha by its own opacity.
- **light raises alpha.** Additive particles, emissive halos and bloom add light where coverage
  may be 0. The final pass writes `a = max(a, min(1, maxRGB))`, so output never has `rgb > a`,
  whose result the WebGPU spec leaves to the browser. A glow over a white panel still brightens
  what's under it, but it also slightly occludes it, as a real glow on glass would.

Opaque surfaces take exactly today's path (the passes compile the alpha code out with a define), so
existing golden images don't change.

### Shadow catcher

`defineMaterial('shadow-catcher', …)`, which is unlit: color 0, alpha `opacity × (1 − visibility)`,
where visibility comes from the shadow maps of every shadow-casting light. The dice tray floor
uses it, so shadows fall on the page.

### Shared devices across apps

Two apps can share one `GpuContext` (`renderPlugin({ gpu })` already exists). This spec makes that
safe:

- module-level caches keyed by `gpu.generation` become per-device (`particles/src/sim.ts`
  `identityBuf` is the known case); a test with two apps on one device and two devices catches
  the rest.
- global registries that must stay global (asset types, material types) are idempotent: two apps
  registering the same definition is fine, and a different definition under the same name fails
  with `render/registry-conflict`.
- each app's resources are counted separately, so one app's `dispose()` never frees another's.

### On-demand frames

`animationFrameRunner({ mode: 'on-demand' })` requests an animation frame only when:

1. the world changed since the last frame. `World` gets one `onWake` callback, set by the runner,
   fired on the first mutation after a frame ends: `set`, `spawn`, `despawn`, `insertResource`,
   `send`, or one of the new resource writes below. That's one boolean check per write, with no
   allocation.
2. something holds a **frame demand**: `FrameDemand.hold(key)` / `release(key)`. Built-in holders
   are awake physics bodies, live particle systems, playing animations, tweens and transitions,
   the `RenderScale` controller while probing, and any system that must run each frame.
3. input arrived, a surface resized, `app.requestFrame()` was called, or a timer asked for a
   frame (`FrameDemand.after(ms)`, for ambient loops at low rates).

**Resource writes are explicit.** `world.resource(R)` returns the object itself, so a bare field
assignment (`world.resource(FogSettings).viewerOpacity = 0.45`) is invisible to the world. Two new
calls make it visible, and both also give resources a change tick (`world.resourceChanged(R,
since)`), which systems can use like component change detection:

- `world.patchResource(R, partial)` assigns the fields, marks the resource changed, and wakes;
- `world.touchResource(R)` marks it changed and wakes, after in-place edits.

The rule is that code outside a frame (host code, protocol handlers, UI callbacks) writes
resources only through these, `insertResource`, or plugin setters that call them; or it calls
`app.requestFrame()`. Systems running inside a frame may still assign fields directly, because a
frame is already running. The protocol's `resource.set` switches to `patchResource`. Every spec
that shows a host writing a resource uses these calls. In dev builds, the on-demand runner hashes
the plain-object resources a plugin marks `hostWritable` when it goes idle and checks them each
second. A changed hash with no wake logs `runtime/unmarked-resource-write`, naming the resource.

On waking, `Time` clamps the delta to one fixed step and the fixed accumulator resets, so a scene
idle for a minute doesn't simulate the minute. `mode: 'continuous'` (the default) stays as it is.

### Teardown

```ts
await app.dispose()
```

Plugins get an optional `dispose?(app)`, called in reverse build order. The runner stops first,
then plugins release what they created. The render plugin destroys buffers and textures and
removes its surface (and the device, only if it created it). Input sources, the `DisplayRate`
probe, observers and device-loss listeners are all detached. `dispose()` is idempotent, and any
call on a disposed app throws `runtime/disposed`.

`GpuContext` counts the live objects it created, per owner (`gpu.stats(owner)` →
`{ buffers, textures, bytes }`), so a test can assert the count returns to its baseline.

### API sketch

```ts
interface SurfaceOptions { alpha?: 'opaque' | 'premultiplied' }
interface Surface extends RenderTarget { readonly canvas: HTMLCanvasElement; remove(): void }
interface GpuContext { addSurface(canvas: HTMLCanvasElement, o?: SurfaceOptions): Surface; stats(owner?: string): GpuStats }

renderPlugin({ gpu, surface }) | renderPlugin({ canvas, alpha: 'premultiplied' })
animationFrameRunner({ mode: 'on-demand', signal })
world.resource(FrameDemand).hold('dice/presentation')
app.requestFrame()
await app.dispose()
```

### Agent surface

- `render.describe` gains `surfaces[]` (size, alpha mode) and `frames: { mode, demands[] }`,
  naming each holder that is keeping frames running.
- `gpu.stats` via the protocol, per owner.

## Decisions

- **Clamp to `rgb ≤ a` instead of relying on unclamped premultiplied output.** WebGPU leaves
  `rgb > a` to the implementation, so it would look different across Chrome, Safari and Firefox.
- **One wake callback on `World`, not change polling.** Polling needs a rAF loop, which is the
  thing on-demand mode removes.
- **Surfaces, not multiple devices.** One device lets the dice and table apps share pipelines,
  textures and screen-space effect data (0054's lens fields), and halves the driver memory.

## Acceptance criteria

- [ ] Headless: a camera clearing to alpha 0 over an offscreen `rgba8unorm` target reads back
      alpha 0 where nothing drew, 1 on an opaque mesh, and the material alpha on a blended one,
      with tonemap, FXAA, TAA and bloom enabled.
- [ ] No pixel of a transparent view's output has any channel above its alpha (checked on a scene
      with additive particles and bloom).
- [ ] Opaque views render byte-identical golden images before and after this change.
- [ ] A shadow catcher under a lit cube reads alpha 0 outside the shadow and `opacity` inside it.
- [ ] Two apps on one `GpuContext` render to two surfaces. Disposing one leaves the other's
      `gpu.stats` unchanged and still rendering.
- [ ] After `app.dispose()`, `gpu.stats(owner)` is 0, the surface is unconfigured, and no rAF,
      listener or observer remains. 100 create/dispose cycles show no growth.
- [ ] On-demand mode: an idle scene requests 0 animation frames over 5 s. A `world.set` from the
      host produces exactly 1 frame. A falling physics body keeps frames running until it sleeps,
      then they stop.
- [ ] While idle in on-demand mode, `world.patchResource(FogSettings, { viewerOpacity: 0.45 })`
      produces exactly 1 frame, and the fog renders at 0.45 in it. A bare field assignment
      produces no frame, and in a dev build logs `runtime/unmarked-resource-write` within 1 s.
- [ ] Device loss on a premultiplied surface restores it as premultiplied.

## Open questions

- Should `FrameDemand.after(ms)` ambient loops pause when `document.hidden`? Proposed: yes, and so
  do all demands, through the platform's visibility signal.
