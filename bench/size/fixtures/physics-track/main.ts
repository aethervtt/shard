// physics-track (0053): records and samples a track with `@aethervtt/shard-physics/track` alone.
// budgets.json forbids renderer and GPU code in it: the recorder runs where neither exists.
import { recordTrack, sampleTrack, type TrackScene, trackHash } from '@aethervtt/shard-physics/track'

const scene: TrackScene = {
  version: 1,
  dim: 3,
  step: 1 / 60,
  maxSteps: 480,
  gravity: [0, -9.81, 0],
  fixed: [
    {
      shape: 'cuboid',
      halfExtents: [5, 0.5, 5],
      translation: [0, -0.5, 0],
      friction: 0.5,
      restitution: 0.3,
      density: 1,
    },
  ],
  bodies: [
    {
      id: 'die',
      translation: [0, 2, 0],
      rotation: [0, 0, 0, 1],
      linear: [1, 0, 0],
      angular: [4, 2, 0],
      colliders: [
        { shape: 'cuboid', halfExtents: [0.3, 0.3, 0.3], friction: 0.5, restitution: 0.3, density: 1 },
      ],
    },
  ],
}

const track = await recordTrack(scene)
const pos = new Float32Array(3)
const rot = new Float32Array(4)
sampleTrack(track, track.steps * track.step, 0, pos, rot)
document.getElementById('out')!.textContent = `${trackHash(track)} ${pos.join(' ')}`
