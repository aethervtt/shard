# 0085 — Published consumer compatibility

- **Status:** draft
- **Packages:** audio, dice, gpu-webgl2, text, texture, gltf, noise, platform-node, runtime
- **Depends on:** 0052, 0054, 0056, 0064, 0079

## Context

Aether's migration to published 0.2.1 exposed initialization cycles, presentation state leaks,
codec bundling failures, and slowed animations under timed demand. Source-only tests did not
exercise the installed JavaScript graph or browser asset and worker emission.

## Goals

- Preserve public exports, schemas, Node tools and browser rendering.
- Exercise installed tarballs in Node, Bun, Vite and webpack and execute production browser output.
- Keep Aether read-only; fix source, without publishing or changing release versions.

## Non-goals

- A release, changes to Aether, or changing deterministic fixed-step simulation semantics.
- Browser MikkTSpace tangent generation (currently an explicit Node-only importer operation).

## Design

Music schema, validation and pure timing helpers live in an acyclic definition module, re-exported
from music. Checkpoints consume the definition directly. Cached dice materials reset fade/result/
resultTime at presentation spawn, before reduced placement applies its fade. Entrance materials
remain per die; resource caches remain per world.

Presentation explicitly selects BACK on the default draw framebuffer before blitting. Framebuffer
bindings and draw buffers are not cached in GlState; scissor and clear mutations use its methods.
The BACK array is reused, without allocation in present.

Codec filesystem access and CommonJS evaluation context live in platform-node's conditional
`/codecs` entry: browser bundlers resolve its browser implementation, Node its default. Browser
fetch is real, not a stub; unsupported Node-only operations throw structured errors. Literal
Basis asset URLs expose all four files to bundlers. Noise uses the same boundary for its
scalar/SIMD WASM loaders, eliminating the remaining shared Node filesystem import. WebP imports
its fully specified `.js` entry. ETC1S supplies quality 128 instead of the invalid -1 default.
The release packer preserves nested export conditions. OpenType's namespace is copied before
testing the CommonJS default wrapper, so an ESM
bundler never resolves a nonexistent default export.

This conditional entry is limited to immutable package-owned codec bootstrap, including standalone
APIs that run before an App or Platform exists. Application file access continues to use the
injected Platform interface. No Node host API is imported from engine modules.

Timed on-demand frames retain elapsed presentation time (subject to maxDelta); simulation on a
wake still gets one fixed step and resets its accumulator. `App.update(delta, fixedDelta = delta)`
provides that distinction without changing existing callers. Ordinary idle wakes retain one-step
presentation deltas; pause/resume and visibility changes exclude time spent suspended. A timer
armed by a running presentation preserves its clock even if another event wakes it early.

Dice workers stay module workers with lazy physics chunks. Vite consumers configure
`worker: { format: 'es' }`; the packed consumer fixture and shipped dice README show this.

### Agent surface

Existing time, frame-demand, dice and rendering inspection continues to apply.

## Decisions

- Conditional host entry avoids Node import workarounds in every browser consumer.
- Keep lazy worker chunks instead of eagerly loading all physics merely to support IIFE output.
- Keep simulation and presentation deltas distinct only when the runner needs it.

## Acceptance criteria

- [x] Audio packed imports initialize, retain schema identity and validate definitions.
- [x] Cancelled reduced previews, rapid replacements, ordinary/critical results and entrances reset
      cached state without disturbing other active dice or intentional reduced fades.
- [x] Shared differently sized opaque and transparent surfaces remain visibly correct after resizes.
- [x] Actual font parsing and Basis encode/transcode pass in Node, Bun and browser production builds.
- [x] Vite and webpack compile without consumer Node externals; emitted codec fetches succeed.
- [x] Packed dice worker resolves and executes a roll in a real browser.
- [x] 4.8-second presentation timing matches elapsed time at display, 30 and 20 fps; idle, pause,
      visibility and fixed-step behavior are preserved.
- [x] Repository typecheck, correctness tests, lint, size budgets and packed consumer checks pass.
- [ ] Repository serial benchmarks pass on a recognized reference machine.

## Local verification (2026-10-19)

The installed consumer used 47 tarballs, Node 22.22.3 (also checked with Node 26.12.0),
Bun 1.4.3, Vite 6.4.3 and 8.3.4, webpack 5.112.0, Next 16.4.2 with webpack, and
Playwright 1.63.0 Chromium. Production Vite 6/8, webpack and Next and Vite 6 development
all executed fonts, Basis ETC1S/UASTC with four mips, WebP, naga and scalar/SIMD noise.
Asset requests returned 200 with WASM content types. Each browser run checked 32 alternating
surface presentations, 12 scene/transparent-dice resizes, and a real worker roll (one worker,
two replies). Presentation clocks reached 4.8 seconds in 4.816–4.884 wall seconds at
display/30/20 fps. PNGs and JSON evidence are written by `bench/consumer/browser.mjs`.

Negative checks restored the original audio import graph, OpenType fallback, dice state,
default draw buffer handling, ETC1S quality and timed-wake delta separately: each relevant
regression failed. The original clock took 9.6 seconds at 30 fps and 14.4 at 20 fps.
Vite 6 IIFE worker output failed production compilation as expected.

`pnpm typecheck`, `pnpm test` (100 tasks), `pnpm lint` (five existing warnings), and
`pnpm size --check` passed. The packed gate is `pnpm release --check --out <isolated directory>`;
its browser step also exercises Vite development mode. No packages were published during
implementation validation; release 0.2.2 was subsequently authorized.

The local serial benchmark run uses an Apple M5 Max, absent from `machines.json`; the runner
therefore disables named-machine budgets (allocation checks and direct timing ratios still run).
Two unrelated checks fail locally: controls observes one collection instead of zero, also
reproduced with the original App implementation; structure's low-quality interior solve takes
175.5 ms against a 148.4 ms half-of-medium threshold. These are not correctness-test failures
or waived budgets. `pnpm bench --continue` completed all 100 tasks in 19m03s: 98 passed,
controls and structure failed. All affected-package suites passed. The report measured 125/126
scenario budgets and listed 14 advisory overruns against its fallback laptop profile.
Reference-machine performance acceptance remains open.

### Consumer upgrade and release 0.2.2

All five Aether 0.2.1 patches can be removed when upgrading the rebuilt graph. Remove the
Shard-specific Next browser Node externals/dynamic-import workaround. Keep Vite 6 ES worker
output and worker/WASM development exclusions; the shipped dice README gives the codec
development exclusions and nested CommonJS optimization setting as well. Timed animation
demand can use 20/30 fps again instead of forcing `animated: true`; it still needs demand.
Browser MikkTSpace tangent generation remains explicitly unsupported, as before.

Changed runtime packages: audio, dice, gpu-webgl2, text, texture, gltf, noise, platform-node,
runtime. Release 0.2.2 rebuilds the complete dependency graph together through the existing
tag-triggered workflow. The performance limitations above remain documented for follow-up.

## Open questions

None; validation results determine readiness for the later release.
