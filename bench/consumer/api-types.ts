// Exercise declarations beyond renderer-min, without adding runtime code to its bundle.
// In particular, FontSource must bring its bundled opentype.js declarations into scope.
import type * as Audio from '@aethervtt/shard-audio'
import type * as AudioEditor from '@aethervtt/shard-audio-editor'
import type * as AudioEditorDom from '@aethervtt/shard-audio-editor/dom'
import type * as AudioPreview from '@aethervtt/shard-audio-preview'
import type * as Cards from '@aethervtt/shard-cards'
import type * as Dice from '@aethervtt/shard-dice'
import type * as Effects from '@aethervtt/shard-effects'
import type * as Scatter from '@aethervtt/shard-scatter'
import type * as Text from '@aethervtt/shard-text'

export interface PublishedApis {
  audio: typeof Audio
  audioEditor: typeof AudioEditor
  audioEditorDom: typeof AudioEditorDom
  audioPreview: typeof AudioPreview
  cards: typeof Cards
  dice: typeof Dice
  effects: typeof Effects
  scatter: typeof Scatter
  text: typeof Text
}
