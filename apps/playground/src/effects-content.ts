import { parsePropertyClip } from '@aethervtt/shard-animation'
import { assetServer } from '@aethervtt/shard-assets'
import { AudioEvent, audioClip } from '@aethervtt/shard-audio'
import type { World } from '@aethervtt/shard-core'
import { ParticleEffect } from '@aethervtt/shard-particles'
import { registerPrefab } from '@aethervtt/shard-scene'

/** Demo host assets: generated once, then accessed exclusively through catalog identities. */
export function registerSpellAssets(world: World): void {
  const catalog = assetServer(world)
  const cast = parsePropertyClip(
    {
      duration: 0.6,
      tracks: [
        {
          path: '',
          component: 'core/Transform',
          field: 'scale',
          keys: [
            [0, [1, 1, 1]],
            [0.3, [1.4, 1.4, 1.4]],
            [0.6, [1, 1, 1]],
          ],
        },
      ],
    },
    'cast',
  )
  catalog.virtual('spell-cast', 'catalog/cast', 'AnimationClip', () => cast)
  for (const kind of ['flame', 'sparks']) {
    const effect = ParticleEffect.fromJson({
      emitters: [
        {
          name: kind,
          capacity: 512,
          spawn: kind === 'flame' ? { rate: 400 } : { rate: 0, bursts: [{ time: 0, count: 350 }] },
          shape: { type: 'sphere', radius: 0.12 },
          init: {
            lifetime: kind === 'flame' ? [0.3, 0.7] : [0.8, 1.5],
            speed: kind === 'flame' ? [0.2, 1] : [2, 5],
            size: [0.04, 0.14],
            color: '#ff7425',
          },
          update: [
            { module: 'gravity', acceleration: [0, kind === 'flame' ? 1 : -2, 0] },
            {
              module: 'color-over-life',
              gradient: [
                [0, '#fff2bf', 1],
                [0.3, '#ff8b2e', 1],
                [1, '#ff3010', 0],
              ],
            },
          ],
          render: { blend: 'additive', emissive: 120 },
        },
      ],
    })
    catalog.virtual(`spell-${kind}`, `catalog/${kind}`, 'ParticleEffect', () => effect)
  }
  for (const [id, frequency] of [
    ['launch', 180],
    ['impact', 64],
  ] as const) {
    const clip = audioClip(spellSound(frequency), { id: `spell-${id}-clip` })
    catalog.virtual(`spell-${id}-clip`, `catalog/${id}.wav`, 'AudioClip', () => clip)
    const event = AudioEvent.deserialize({
      layers: [
        {
          id: 'body',
          choices: [{ clip: { guid: `spell-${id}-clip` } }],
          gainDb: -8,
          spatial: true,
          minDistance: 5,
        },
      ],
    })
    catalog.virtual(`spell-${id}`, `catalog/${id}.audio-event.json`, AudioEvent.name, () => event)
  }
  registerPrefab(world, 'catalog/caster.prefab.json', {
    version: 1,
    assets: {
      material: {
        type: 'Material',
        value: { baseColor: '#24c4df', metallic: 0.5, roughness: 0.3 },
      },
    },
    root: {
      name: 'caster',
      components: {
        'core/Transform': { translation: [-4, 0.65, 0] },
        'render/Mesh3d': { mesh: { path: 'procedural:box?x=0.7&y=1.3&z=0.7' } },
        'render/MeshMaterial': { material: { path: '#material' } },
      },
    },
  })
  for (const [id, x] of [
    ['projectile', -4],
    ['impact', 4],
  ] as const)
    registerPrefab(world, `catalog/${id}.prefab.json`, {
      version: 1,
      root: {
        name: id,
        components: {
          'core/Transform': { translation: [x, 1, 0] },
          'render/PointLight': { intensity: 0, color: '#ff8a25', range: 8 },
        },
      },
    })
}

function spellSound(frequency: number): Uint8Array {
  const rate = 24000,
    frames = rate * 2,
    bytes = new Uint8Array(44 + frames * 2),
    view = new DataView(bytes.buffer)
  const text = (at: number, value: string) => {
    for (let i = 0; i < value.length; i++) bytes[at + i] = value.charCodeAt(i)
  }
  text(0, 'RIFF')
  view.setUint32(4, bytes.length - 8, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, frames * 2, true)
  for (let i = 0; i < frames; i++) {
    const time = i / rate
    const envelope = Math.min(1, time * 50) * Math.exp(-time * 2.5)
    const wave = Math.sin(2 * Math.PI * (frequency * time + 25 * (1 - Math.exp(-time * 4))))
    view.setInt16(44 + i * 2, Math.round(wave * envelope * 12000), true)
  }
  return bytes
}
