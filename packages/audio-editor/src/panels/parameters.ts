import { type AudioEditorMountOptions, mountPanel } from './common'
export function mountAudioParameters(container: HTMLElement, options: AudioEditorMountOptions) {
  return mountPanel(container, options, 'parameters')
}
