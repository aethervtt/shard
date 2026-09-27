import { First, PostUpdate } from '@aethervtt/shard-core'
import { updateActions, updateInput } from '@aethervtt/shard-input'
import { definePlugin } from '@aethervtt/shard-runtime'
import { Fonts, installLocalization, localizeComponent, localizeText } from '@aethervtt/shard-text'
import { TransformSystems } from '@aethervtt/shard-transform'
import { UiDefaults, UiText } from './components'
import { interactUi, UiPointer } from './interaction'
import { uiMethods } from './methods'
import { installUiRenderer } from './render'
import { UiThemes } from './theme'
import { layoutUi, observeUiStructure, UiState } from './tree'

/**
 * Retained UI: UiNode trees under UiRoots laid out by flexbox after transforms, drawn over the
 * finished image, and driven by the pointer, keyboard, and gamepad. Without a renderer (headless)
 * everything but drawing runs, so layout and clicks are testable.
 */
export const uiPlugin = definePlugin({
  name: 'ui',
  dependencies: ['core/transform'],
  build(app) {
    const w = app.world
    w.initResource(UiState)
    w.initResource(UiPointer)
    w.initResource(UiThemes)
    w.initResource(UiDefaults)
    // Text measures with fonts even without the text renderer (headless layout).
    w.initResource(Fonts)
    observeUiStructure(w)
    installLocalization(app)
    localizeComponent(w, UiText)
    app
      .addSystems(First, interactUi.after(updateInput).before(updateActions))
      .addSystems(PostUpdate, layoutUi.after(TransformSystems, localizeText))
    app.addMethod(...uiMethods)
  },
  ready(app) {
    installUiRenderer(app)
  },
})
