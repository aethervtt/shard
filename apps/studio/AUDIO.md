# Studio audio workspace

Use **Audio workspace** in Studio (or launch its page with `?workspace=audio`). Enter a Shard
project folder inside the desktop host's granted filesystem scope and choose **Open audio
project**. Studio validates `shard.json`, browses its configured asset roots, and mounts the same
framework-independent editor used by websites. The audio-only entry does not initialize a GPU.

Files are accessed through `Platform.fs`; only `platform-tauri` imports desktop SDK APIs. Clip
selection comes from the project catalog. The folder setting selects a project, not an arbitrary
playback source. The shipped desktop capability grants the user's home and app-data folders.

Saving existing documents checks their original source revision. No-op saves preserve source
bytes. This adapter serializes its own writes and detects external changes before writing;
`PlatformFileSystem` does not provide a cross-process compare-and-swap primitive. Coordinate
external writers through one project host. Atomic multi-document changes are unavailable.

The `Audio editor / native Studio webview` CI job builds the actual desktop binary and drives
WebKitGTK through Tauri's WebDriver. It opens a copy of audio-lab, edits an event, verifies the
saved source, auditions through a real button click, reloads the window and reopens the saved
value. Screenshots and native capability details are artifacts. Playwright WebKit results are
reported separately and are not used as evidence of the desktop webview.
