import { type AudioEditorMountOptions, type AudioEditorView, mountPanel } from './panels/common'

export { drawAudioWaveform } from './drawing'
export type {
  AudioEditorMountOptions,
  AudioEditorPanel,
  AudioEditorSceneSelection,
  AudioEditorView,
} from './panels/common'
export { audioEditorStyles } from './styles'

/** Mount an owned, scoped view. The caller retains ownership of its session and host container. */
export function mountAudioEditor(
  container: HTMLElement,
  options: AudioEditorMountOptions,
): AudioEditorView {
  return mountPanel(container, options)
}
