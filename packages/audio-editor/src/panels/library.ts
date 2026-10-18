import { type AudioEditorMountOptions, mountPanel } from './common'
export function mountAudioLibrary(container: HTMLElement, options: AudioEditorMountOptions) {
  return mountPanel(container, options, 'library')
}
