import { type AudioEditorMountOptions, mountPanel } from './common'
export function mountAudioEvent(container: HTMLElement, options: AudioEditorMountOptions) {
  return mountPanel(container, options, 'event')
}
