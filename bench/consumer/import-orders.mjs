import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

// Each traversal starts in a fresh ESM graph. A barrel-first import can hide a TDZ cycle.
const entry = import.meta.resolve('@aethervtt/shard-audio')
for (const first of ['music.js', 'events.js', 'checkpoint.js', 'index.js']) {
  const code = `
    await import(${JSON.stringify(new URL(first, entry).href)});
    const api = await import('@aethervtt/shard-audio');
    const definition = await import(${JSON.stringify(new URL('music-definition.js', entry).href)});
    if (api.MusicProgram !== definition.MusicProgram) throw new Error('music schema identity');
    console.log('ok');
  `
  assert.equal(
    execFileSync(process.execPath, ['--input-type=module', '-e', code], {
      encoding: 'utf8',
    }).trim(),
    'ok',
  )
}
console.log('audio: four fresh packed import traversals preserve schema identity')
