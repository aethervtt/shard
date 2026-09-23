/**
 * Structured engine error. Agents read `code` and `hint`; humans read `message`.
 * Codes are namespaced by package, e.g. `gpu/unsupported`, `platform/fs-read-only`.
 */
export class ShardError extends Error {
  override readonly name = 'ShardError'
  readonly code: string
  readonly hint: string | undefined
  /** Location of the problem: a file path, an entity path, a JSON pointer. */
  readonly path: string | undefined
  /** Related errors, e.g. every problem found when validating a whole file. */
  readonly details: readonly ShardError[] | undefined

  constructor(
    code: string,
    message: string,
    options: {
      hint?: string
      path?: string
      cause?: unknown
      details?: readonly ShardError[]
    } = {},
  ) {
    super(message, { cause: options.cause })
    this.code = code
    this.hint = options.hint
    this.path = options.path
    this.details = options.details
  }

  toJSON(): { code: string; message: string; hint?: string; path?: string; details?: unknown[] } {
    const out: {
      code: string
      message: string
      hint?: string
      path?: string
      details?: unknown[]
    } = {
      code: this.code,
      message: this.message,
    }
    if (this.hint !== undefined) out.hint = this.hint
    if (this.path !== undefined) out.path = this.path
    if (this.details) out.details = this.details.map((d) => d.toJSON())
    return out
  }
}
