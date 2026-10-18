import { drawAudioWaveform, mountAudioEditor } from '@aethervtt/shard-audio-editor/dom'
import {
  createAudioEditorSession,
  createMemoryAudioHost,
} from '@aethervtt/shard-audio-editor/model'
import { createIsolatedAudioPreview } from '@aethervtt/shard-audio-editor/preview'
import { createWebAudioBackend } from '@aethervtt/shard-platform-web'
import { createDemoAudioHost } from './audio-editor-host'

async function main() {
  const host = createDemoAudioHost('demo-world'),
    compactHost = createDemoAudioHost('independent-world')
  const preview = createIsolatedAudioPreview({ assets: host.assets, documents: host.documents })
  const compactPreview = createIsolatedAudioPreview({
    assets: compactHost.assets,
    documents: compactHost.documents,
  })
  const session = createAudioEditorSession({ ...host, preview })
  const compactSession = createAudioEditorSession({ ...compactHost, preview: compactPreview })
  const full = document.querySelector<HTMLElement>('#full')!,
    compact = document.querySelector<HTMLElement>('#compact')!
  const editor = mountAudioEditor(full, { session, layout: 'full', theme: 'dark' })
  const mixer = mountAudioEditor(compact, {
    session: compactSession,
    layout: 'compact',
    theme: 'dark',
  })
  const example = document.querySelector<HTMLSelectElement>('#example')!
  for (const doc of host.records.values()) {
    const option = document.createElement('option')
    option.value = doc.id
    option.textContent = doc.name
    example.append(option)
  }
  const first = [...host.records.values()].find((doc) => doc.name === 'Engine')!
  example.value = first.id
  await session.open(first.id)
  await compactSession.open(
    [...compactHost.records.values()].find((doc) => doc.type === 'audio/AudioMixer')!.id,
  )
  example.onchange = () => {
    void session.open(example.value)
  }
  document.querySelector<HTMLSelectElement>('#theme')!.onchange = (event) => {
    const theme = (event.target as HTMLSelectElement).value as 'dark' | 'light'
    document.documentElement.dataset.theme = theme
    editor.setTheme(theme)
    mixer.setTheme(theme)
  }
  document.querySelector<HTMLButtonElement>('#narrow')!.onclick = () => {
    full.style.width = '300px'
    compact.style.width = '300px'
  }
  document.querySelector<HTMLButtonElement>('#wide')!.onclick = () => {
    full.style.width = '900px'
    compact.style.width = '400px'
  }
  document.querySelector<HTMLButtonElement>('#download')!.onclick = () => {
    const doc = session.state.document
    if (!doc) return
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(doc.value, null, 2)], { type: 'application/json' }),
    )
    const link = document.createElement('a')
    link.href = url
    link.download = doc.name
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }
  document.querySelector('#status')!.textContent =
    'Two independent audio sessions. Changes stay in this tab until downloaded.'
  Object.assign(globalThis, {
    audioEditorDemo: {
      session,
      compactSession,
      host,
      compactHost,
      editor,
      mixer,
      preview,
      compactPreview,
      mountAudioEditor,
      createAudioEditorSession,
      createMemoryAudioHost,
      drawAudioWaveform,
      createIsolatedAudioPreview,
      createWebAudioBackend,
    },
  })
}
void main().catch((error: unknown) => {
  document.querySelector('#status')!.textContent = String(error)
  console.error(error)
})
