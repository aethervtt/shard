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

  constructor(
    code: string,
    message: string,
    options: { hint?: string; path?: string; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause })
    this.code = code
    this.hint = options.hint
    this.path = options.path
  }

  toJSON() {
    return { code: this.code, message: this.message, hint: this.hint, path: this.path }
  }
}
