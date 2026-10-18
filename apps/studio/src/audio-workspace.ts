import { mountAudioEditor } from '@aethervtt/shard-audio-editor/dom'
import { createAudioEditorSession } from '@aethervtt/shard-audio-editor/model'
import { createIsolatedAudioPreview } from '@aethervtt/shard-audio-editor/preview'
import { openAudioProject } from '@aethervtt/shard-audio-editor/project'
import { createTauriPlatform, tauriDirectories } from '@aethervtt/shard-platform-tauri'

/** Explicit project host: the editor never discovers local files or calls Tauri itself. */
export async function openStudioAudioWorkspace() {
  const directories = await tauriDirectories()
  const shell = document.createElement('section')
  shell.style.cssText =
    'position:fixed;inset:0;background:#151923;display:grid;grid-template-rows:auto minmax(0,1fr);z-index:10'
  const controls = document.createElement('form')
  controls.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;padding:12px'
  const label = document.createElement('label')
  label.textContent = 'Audio project folder '
  const path = document.createElement('input')
  path.value = directories.home
  path.name = 'project'
  path.size = 50
  label.append(path)
  const open = document.createElement('button')
  open.textContent = 'Open audio project'
  const theme = document.createElement('button')
  theme.type = 'button'
  theme.textContent = 'Toggle light / dark'
  const status = document.createElement('span')
  status.setAttribute('role', 'status')
  const content = document.createElement('div')
  content.style.cssText = 'min-height:0;min-width:0'
  controls.append(label, open, theme, status)
  shell.append(controls, content)
  document.body.append(shell)
  let cleanup: (() => Promise<void>) | undefined
  let view: ReturnType<typeof mountAudioEditor> | undefined
  let light = false
  theme.onclick = () => {
    light = !light
    view?.setTheme(light ? 'light' : 'dark')
  }
  controls.onsubmit = (event) => {
    event.preventDefault()
    open.disabled = true
    void (async () => {
      if (
        cleanup &&
        !window.confirm('Close the current audio project? Unsaved edits will be discarded.')
      )
        return
      await cleanup?.()
      cleanup = undefined
      status.textContent = 'Opening…'
      const platform = createTauriPlatform({ projectRoot: path.value, dataDir: directories.data })
      const project = await openAudioProject(platform, path.value)
      const preview = createIsolatedAudioPreview({
        assets: project.assets,
        documents: project.documents,
      })
      const session = createAudioEditorSession({
        assets: project.assets,
        documents: project.documents,
        preview,
      })
      view = mountAudioEditor(content, { session, layout: 'full', theme: light ? 'light' : 'dark' })
      cleanup = async () => {
        view?.dispose()
        await session.dispose()
        project.dispose()
      }
      const first = (await project.assets.list({ type: 'audio/AudioEvent', limit: 1 })).items[0]
      if (first) await session.open(first.id)
      status.textContent = project.name
    })()
      .catch((error: unknown) => {
        status.textContent = String(error)
      })
      .finally(() => {
        open.disabled = false
      })
  }
}
