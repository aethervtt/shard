import type { TrackContactOptions } from '../track/record'
import type { TrackScene } from '../track/scene'

// Messages between a track client and its worker (0053). Plain data: a settle rule travels as a
// name and its parameters, and a track as one transferred buffer.

/** A settle rule the worker registered, and the parameters for this recording. */
export interface SettleRuleRef {
  rule: string
  params?: unknown
}

export type TrackRequest =
  | { type: 'init' }
  | {
      type: 'record'
      id: number
      scene: TrackScene
      settle?: SettleRuleRef
      contacts?: TrackContactOptions
    }
  | { type: 'cancel'; id: number }
  | { type: 'dispose' }

export type TrackReply =
  | { type: 'ready'; engine: string }
  | { type: 'track'; id: number; buffer: ArrayBuffer }
  /** `id` null: `init` failed. */
  | {
      type: 'error'
      id: number | null
      code: string
      message: string
      hint?: string
      path?: string
    }
