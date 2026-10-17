import {
  configureAudioMixer,
  playAudioEvent,
  prepareAudio,
  prepareMusic,
  setAudioParameter,
  setMusicParameter,
  startMusic,
} from '@aethervtt/shard-audio'
import { defineResource, defineSystem, Update, type World } from '@aethervtt/shard-core'
import { defineProject } from '@aethervtt/shard-project'
import { LogResource, Time } from '@aethervtt/shard-runtime'

const Demo = defineResource<{ engine: number; score: number; beat: number }>('audio-lab/Demo')
const tour = defineSystem({
  name: 'audio-lab/tour',
  setup: () => ({ started: false }),
  run(state, world) {
    if (!state.started) {
      state.started = true
      void initialize(world).catch((error) => world.resource(LogResource).error(error))
    }
    const demo = world.tryResource(Demo)
    if (!demo) return
    const seconds = world.resource(Time).elapsed
    const beat = Math.floor(seconds)
    if (beat === demo.beat) return
    demo.beat = beat
    setAudioParameter(world, demo.engine, 'rpm', (beat % 8) / 7)
    setMusicParameter(world, demo.score, 'intensity', Math.floor(beat / 8) % 2)
    playAudioEvent(world, 'data/audio/footstep.audio-event.json', {
      parameters: { surface: beat % 2 ? 'wood' : 'stone' },
      position: [beat % 2 ? -2 : 2, 0, -3],
    })
    if (beat % 4 === 0) playAudioEvent(world, 'data/audio/spell.audio-event.json')
  },
})

export default defineProject({
  name: 'audio-lab',
  build(app) {
    app.addSystems(Update, tour)
  },
})

async function initialize(world: World) {
  await configureAudioMixer(world, 'data/audio/main.audio-mixer.json')
  await prepareAudio(world, 'data/audio/kit.audio-collection.json')
  const program = await prepareMusic(world, 'data/audio/score.audio-music.json')
  const score = startMusic(world, program)
  program.release()
  const engine = playAudioEvent(world, 'data/audio/engine.audio-event.json', {
    position: [2, 0, -3],
  })
  world.insertResource(Demo, { engine, score, beat: -1 })
}
