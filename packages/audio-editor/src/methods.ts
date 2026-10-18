import { defineSchema, type JsonObject, t } from '@aethervtt/shard-core'
import type { AppMethod } from '@aethervtt/shard-runtime'
import type { AudioEditorSession } from './model'

/** Explicit registration only. The host grants protocol access to this editor session. */
export function audioEditorMethods(session: AudioEditorSession): AppMethod[] {
  const empty = defineSchema('audio-editor/Empty', {})
  return [
    {
      name: 'audio.editor.describe',
      description: 'Inspect audio document revision, draft and diagnostics.',
      params: empty,
      handler: () => {
        const { schema, diagnostics, ...state } = session.state
        return {
          ...state,
          schema: schema?.jsonSchema(),
          diagnostics: diagnostics.map((e) => ({
            code: e.code,
            message: e.message,
            path: e.path,
            hint: e.hint,
          })),
        }
      },
    },
    {
      name: 'audio.editor.edit',
      description: 'Edit one schema-backed audio document field.',
      params: defineSchema('audio-editor/Edit', {
        path: t.string({ required: true }),
        value: t.json(),
        remove: t.bool(),
      }),
      handler: (_, p) => {
        session.edit({
          path: p.path as string,
          value: p.value as JsonObject,
          remove: p.remove as boolean,
        })
        return { updated: true }
      },
    },
    {
      name: 'audio.editor.validate',
      description: 'Validate the draft against the runtime schema and host asset catalog.',
      params: empty,
      handler: async () =>
        (await session.validate()).map((e) => ({
          code: e.code,
          message: e.message,
          path: e.path,
          hint: e.hint,
        })),
    },
    {
      name: 'audio.editor.undo',
      description: 'Undo one authored document transaction.',
      params: empty,
      handler: () => {
        session.undo()
        return { updated: true }
      },
    },
    {
      name: 'audio.editor.redo',
      description: 'Redo one authored document transaction.',
      params: empty,
      handler: () => {
        session.redo()
        return { updated: true }
      },
    },
    {
      name: 'audio.editor.commit',
      description: 'Validate and save the draft through the host revision boundary.',
      params: empty,
      handler: () => session.save(),
    },
  ]
}
