# Audio preview rendering

Optional browser tooling shared by the CLI and audio editor. `renderAudioBundle` consumes an
`AudioRenderBundle` containing the existing audio render plan and resolved runtime assets, then
returns a WAV, measurements and control trace. The caller supplies authorized assets; this
package does not discover files, resolve user URLs or depend on editor documents or DOM panels.

Rendering requires `OfflineAudioContext` with scheduled suspend/resume. Unsupported browsers
return a structured capability error. A cancellation signal stops scheduling and releases owned
runtime resources. Output is bounded to 64 MiB; stream assets need a host-supported decoded
export path. Rendered samples establish signal behavior, not physical speaker timing.

Browser evidence lives in `apps/playground/src/audio-editor-preview.test.ts` and the existing
CLI/audio preview tests. Importing this package creates no context or running audio session.
