import { ShardError } from '@aethervtt/shard-core'
import { describe, expect, it } from 'vitest'
import { builtinFont } from './fallback-font'
import { FontAssetType } from './importer'

// A font that failed to load draws with the engine's built-in one (0061).

describe('built-in fallback font', () => {
  it('covers printable ASCII from its own atlas, with ? for the rest', () => {
    const font = builtinFont()
    expect(font.name).toBe('shard-fallback')
    expect(font.pages).toHaveLength(1)
    expect(font.pages[0]!.texture?.width).toBe(192)
    const a = font.resolve('A'.codePointAt(0)!)
    expect(a.visible).toBe(true)
    expect(a.advance).toBeGreaterThan(0.4)
    expect(font.resolve(' '.codePointAt(0)!).visible).toBe(false)
    // Outside ASCII: the missing-glyph box, which is '?'.
    expect(font.resolve(0x4e2d).u0).toBe(font.resolve('?'.codePointAt(0)!).u0)
  })

  it('is what the Font asset type falls back to', () => {
    const fallback = FontAssetType.fallback!({
      guid: 'f',
      path: 'fonts/gone.ttf',
      error: new ShardError('assets/load-failed', 'HTTP 404'),
      dev: false,
      world: undefined as never,
    })
    expect(fallback.name).toBe('shard-fallback')
  })
})
