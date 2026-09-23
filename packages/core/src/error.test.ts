import { describe, expect, it } from 'vitest'
import { ShardError } from './error'

describe('ShardError', () => {
  it('serializes to a structured object', () => {
    const err = new ShardError('test/code', 'Something broke', { hint: 'Fix it', path: 'a/b' })
    expect(err).toBeInstanceOf(Error)
    expect(JSON.parse(JSON.stringify(err))).toEqual({
      code: 'test/code',
      message: 'Something broke',
      hint: 'Fix it',
      path: 'a/b',
    })
  })
})
