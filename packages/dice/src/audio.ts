import {
  AudioBuses,
  AudioEvent,
  AudioEventsState,
  type AudioLease,
  AudioMixState,
  AudioState,
  audioEvents,
  playAudioEvent,
  prepareAudio,
  stopAudioEvent,
} from '@aethervtt/shard-audio'
import { type AssetRef, ShardError, type World } from '@aethervtt/shard-core'

/** Default category for dice, including procedural fallback sounds. */
export const DICE_AUDIO_BUS = 'dice'

const INPUTS = ['strength', 'pitch', 'value', 'high', 'low', 'count', 'contact'] as const
type Input = (typeof INPUTS)[number]
interface Binding {
  ref: AssetRef
  inputs: Input[]
  revision: string
}

/** Preserve host controls; a configured mixer must explicitly include its dice route. */
export function ensureDiceAudioBus(world: World): void {
  if (!world.hasResource(AudioState)) return
  const graph = world.tryResource(AudioMixState)?.graph
  if (graph && !graph.buses.some((bus) => bus.id === DICE_AUDIO_BUS && !bus.return))
    throw new ShardError('dice/audio-bus', 'The active mixer needs an ordinary dice bus', {
      hint: 'Add dice under master in the host mixer before rolling.',
      path: '/buses',
    })
  const buses = world.resource(AudioBuses)
  buses[DICE_AUDIO_BUS] ??= { volume: 1, muted: false, parent: 'master' }
  if (buses[DICE_AUDIO_BUS]!.parent !== 'master' || buses[DICE_AUDIO_BUS]!.userDomain === false)
    throw new ShardError(
      'dice/audio-bus',
      'Dice must be an ordinary category directly under master',
      {
        hint: 'Independent dice user controls require their own category, including effect tails.',
        path: '/buses/dice',
      },
    )
}

function key(ref: AssetRef): string {
  return ref.guid ?? ref.path ?? ''
}

/** A roll owns preparation and instances, independently of rendering and the host's storage. */
export class DiceAudioSession {
  private readonly bindings = new Map<string, Binding>()
  private readonly leases: AudioLease[] = []
  private readonly instances: number[] = []
  private closed = false
  private readonly world: World
  private readonly gain: number

  constructor(world: World, gain: number) {
    this.world = world
    this.gain = gain
  }

  async prepare(refs: readonly AssetRef[]): Promise<void> {
    if (this.closed || this.gain <= 0 || !this.world.hasResource(AudioState)) return
    ensureDiceAudioBus(this.world)
    if (refs.length && !this.world.hasResource(AudioEventsState))
      throw new ShardError(
        'dice/audio-events-missing',
        'Authored dice sounds need audioEventsPlugin',
        {
          hint: 'Install audioEventsPlugin alongside audioPlugin, or remove the event bindings.',
        },
      )
    try {
      for (const ref of refs) {
        if (this.closed) return
        if (this.bindings.has(key(ref))) continue
        const lease = await prepareAudio(this.world, ref)
        if (this.closed) {
          lease.release()
          return
        }
        this.leases.push(lease)
        const plan = lease.events[0]
        if (!plan || lease.events.length !== 1)
          throw new ShardError('dice/audio-event', 'Dice bindings require one audio event')
        const definition = plan.definition
        if (definition.mode !== 'oneshot' || definition.layers.some((layer) => layer.spatial))
          throw new ShardError(
            'dice/audio-event',
            'Dice presentation events must be flat one-shots',
          )
        const buses = this.world.resource(AudioBuses)
        for (const layer of definition.layers) {
          let bus = layer.bus || definition.bus
          let depth = 0
          while (bus && bus !== DICE_AUDIO_BUS && depth++ < 64) bus = buses[bus]?.parent ?? ''
          if (bus !== DICE_AUDIO_BUS)
            throw new ShardError('dice/audio-bus', 'Dice event layers must route through dice', {
              path: `/layers/${layer.id}/bus`,
              hint: 'Set the event bus to dice or a child bus in the host mixer.',
            })
        }
        const inputs: Input[] = []
        for (const parameter of definition.parameters) {
          if (!(INPUTS as readonly string[]).includes(parameter.name)) continue
          if (
            parameter.readonly ||
            parameter.kind === 'label' ||
            (['strength', 'pitch'].includes(parameter.name) && parameter.kind !== 'continuous')
          )
            throw new ShardError('dice/audio-parameter', `Invalid dice input ${parameter.name}`, {
              path: `/parameters/${parameter.name}`,
              hint: 'Use writable numeric inputs; strength and pitch must be continuous.',
            })
          inputs.push(parameter.name as Input)
        }
        this.bindings.set(key(ref), { ref: plan.source ?? ref, inputs, revision: plan.revision })
      }
    } catch (error) {
      this.dispose()
      throw error
    }
  }

  /** Returns true for configured bindings, even when silent, so defaults do not also play. */
  play(
    ref: AssetRef | null,
    seed: number,
    strength: number,
    pitch: number,
    value: number,
    high: boolean,
    low: boolean,
    count: number,
    contact = 0,
    gain = 1,
  ): boolean {
    if (!ref) return false
    if (this.closed || this.gain <= 0 || !this.world.hasResource(AudioState)) return true
    const binding = this.bindings.get(key(ref))
    if (!binding)
      throw new ShardError('dice/audio-not-prepared', 'Prepare the dice event before playback')
    const current = this.world.resource(AudioEvent.store).get(binding.ref)
    if (!current || JSON.stringify(AudioEvent.serialize(current)) !== binding.revision)
      throw new ShardError('dice/audio-changed', 'A dice event changed during its roll', {
        hint: 'Start a new roll to prepare the changed event and validate its routing and inputs.',
      })
    const parameters: Record<string, number> = {}
    for (let i = 0; i < binding.inputs.length; i++) {
      const input = binding.inputs[i]!
      switch (input) {
        case 'strength':
          parameters[input] = strength
          break
        case 'pitch':
          parameters[input] = pitch
          break
        case 'value':
          parameters[input] = value
          break
        case 'high':
          parameters[input] = high ? 1 : 0
          break
        case 'low':
          parameters[input] = low ? 1 : 0
          break
        case 'count':
          parameters[input] = count
          break
        case 'contact':
          parameters[input] = contact
          break
      }
    }
    // Only retain live IDs: a long tumble cannot grow the ownership list without bound.
    const state = audioEvents(this.world)
    let keep = 0
    for (let i = 0; i < this.instances.length; i++) {
      const id = this.instances[i]!
      for (let j = 0; j < state.instances.length; j++) {
        const instance = state.instances[j]
        if (instance?.id === id && instance.state !== 'ended' && instance.state !== 'failed') {
          this.instances[keep++] = id
          break
        }
      }
    }
    this.instances.length = keep
    try {
      this.instances.push(
        playAudioEvent(this.world, binding.ref, {
          seed: seed >>> 0,
          volume: this.gain * gain,
          parameters,
        }),
      )
    } catch (error) {
      // Global audio saturation is an expected dropped transient, never a failed dice roll.
      if (!(error instanceof ShardError) || error.code !== 'audio/capacity') throw error
    }
    return true
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    if (this.world.hasResource(AudioEventsState))
      for (const id of this.instances) stopAudioEvent(this.world, id, { release: 0 })
    for (const lease of this.leases) lease.release()
    this.instances.length = 0
    this.leases.length = 0
    this.bindings.clear()
  }
}
