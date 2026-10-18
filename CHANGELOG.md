# Changelog

All engine packages share one version. During `0.x`, minor releases may change APIs;
patch releases preserve compatibility. Apps and examples are not published.

## 0.2.0

47 packages, including five new packages: `audio-editor`, `audio-preview`, `cards`, `effects`,
and `scatter` (each under `@aethervtt/shard-`).

- Scatter, foliage, and procedural meshes (0045); heightfield terrain with incremental baking,
  streaming, physics, navigation, and scatter integration (0071).
- CPU, GPU, worker, and asset profiling (0074), named performance budgets and scenario captures
  (0075), and post-processing/render-pass performance improvements.
- Cards and decks with PBR materials and extensible foil finishes (0076).
- Authored audio events, parameters, preparation, and voice ownership (0077); mixers, inserts,
  sends, snapshots, and acoustics (0078); adaptive music, preview, and export (0079).
- Embeddable audio authoring panels with host-owned assets and persistence, light/dark themes,
  and layouts that support 300 px docks (0080). The editor remains an early version.
- Reusable effect sequences with preparation, binding, and cancellation (0081), trails and beams
  (0082), and projected color decals on rigid mesh receivers (0083).
- Authored dice impact, entrance, and result audio with parameter-driven layers and independent
  mixing, while retaining procedural defaults (0084).

Upgrade all installed Shard packages together. Review each feature's spec and package documentation
when upgrading from 0.1.0; this release does not promise API compatibility with 0.1.x.

## 0.1.0 — 2026-10-07

42 packages. Specs 0057–0070, including the WebGL2 baseline backend (0064).
Ten packages first published: `controls`, `dice`, `fog`, `gpu-webgl2`, `grid`, `mirror`, `scenes`,
`structure`, `vector`, and `verify`.

## 0.0.1 — 2026-09-28

Initial public engine packages and modular JavaScript/declaration packaging (0056).
