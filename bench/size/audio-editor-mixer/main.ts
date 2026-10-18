import {
  createAudioEditorSession,
  createMemoryAudioHost,
} from '@aethervtt/shard-audio-editor/model'
import { mountAudioMixer } from '@aethervtt/shard-audio-editor/panels/mixer'

Object.assign(globalThis, { mountAudioMixer, createAudioEditorSession, createMemoryAudioHost })
