import { type AudioEditorMountOptions, mountPanel } from './common'
export function mountAudioMusic(container: HTMLElement, options: AudioEditorMountOptions) {
  return mountPanel(container, options, 'music')
}
