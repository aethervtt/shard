import { mountAudioEditor } from '@aethervtt/shard-audio-editor/dom'
import {
  createAudioEditorSession,
  createMemoryAudioHost,
} from '@aethervtt/shard-audio-editor/model'

Object.assign(globalThis, { mountAudioEditor, createAudioEditorSession, createMemoryAudioHost })
