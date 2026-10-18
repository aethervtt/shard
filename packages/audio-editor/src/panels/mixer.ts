import { type AudioEditorMountOptions, mountPanel } from './common'
export function mountAudioMixer(container: HTMLElement, options: AudioEditorMountOptions) {
  return mountPanel(container, options, 'mixer')
}
