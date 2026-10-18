import { type AudioEditorMountOptions, mountPanel } from './common'
export function mountAudioDiagnostics(container: HTMLElement, options: AudioEditorMountOptions) {
  return mountPanel(container, options, 'diagnostics')
}
