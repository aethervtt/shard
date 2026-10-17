import { ShardError } from '@aethervtt/shard-core'
import type {
  AudioBusDesc,
  AudioEffectDesc,
  AudioMixerGraph,
  AudioPreparation,
} from '@aethervtt/shard-platform'
import type { AudioCache } from './audio-cache'

function ramp(param: AudioParam, value: number, at: number, seconds: number): void {
  param.cancelAndHoldAtTime(at)
  if (seconds > 0) param.linearRampToValueAtTime(value, at + seconds)
  else param.setValueAtTime(value, at)
}

/** A compiled Web Audio graph. No DOM or nodes escape the platform boundary. */
export class WebAudioGraph {
  readonly inputs = new Map<string, GainNode>()
  readonly outputs = new Map<string, GainNode>()
  readonly nodes: AudioNode[] = []
  readonly leases: AudioPreparation[] = []
  private readonly values = new Map<string, AudioParam[]>()
  private readonly gates = new Map<string, GainNode>()
  private readonly userGains = new Map<string, number>()
  private readonly ancestry = new Map<string, string[]>()
  private readonly buses = new Map<string, AudioBusDesc>()
  readonly context: BaseAudioContext
  readonly output: GainNode
  readonly maxNodes: number
  tailSeconds = 0

  private constructor(context: BaseAudioContext, graph: AudioMixerGraph, output: GainNode) {
    this.context = context
    this.output = output
    this.maxNodes = graph.maxNodes
    for (const bus of graph.buses) {
      this.buses.set(bus.id, bus)
      this.userGains.set(bus.id, bus.userGain)
    }
  }

  private own<T extends AudioNode>(node: T): T {
    this.nodes.push(node)
    if (this.nodes.length > this.maxNodes)
      throw new ShardError('audio/mixer-capacity', 'Partitioned mixer exceeds its node budget', {
        hint: 'Reduce sends/effects or increase maxNodes; independent user categories require independent effect state.',
      })
    return node
  }

  private bind(key: string, param: AudioParam): void {
    const list = this.values.get(key)
    if (list) list.push(param)
    else this.values.set(key, [param])
  }

  private async effect(
    bus: string,
    effect: AudioEffectDesc,
    cache: Pick<AudioCache, 'acquire'>,
  ): Promise<{ input: AudioNode; output: AudioNode }> {
    const ctx = this.context
    const key = `${bus}/${effect.id}/`
    this.tailSeconds = Math.max(this.tailSeconds, effect.tailSeconds)
    switch (effect.kind) {
      case 'lowpass':
      case 'highpass':
      case 'peaking': {
        const node = this.own(ctx.createBiquadFilter())
        node.type = effect.kind
        node.frequency.value = Math.min(ctx.sampleRate / 2, effect.frequency)
        node.Q.value = effect.q
        node.gain.value = effect.gainDb
        this.bind(`${key}frequency`, node.frequency)
        this.bind(`${key}q`, node.Q)
        this.bind(`${key}gainDb`, node.gain)
        return { input: node, output: node }
      }
      case 'compressor': {
        const node = this.own(ctx.createDynamicsCompressor())
        node.threshold.value = effect.threshold
        node.ratio.value = effect.ratio
        node.attack.value = effect.attack
        node.release.value = effect.release
        this.bind(`${key}threshold`, node.threshold)
        this.bind(`${key}ratio`, node.ratio)
        this.bind(`${key}attack`, node.attack)
        this.bind(`${key}release`, node.release)
        return { input: node, output: node }
      }
      case 'delay': {
        const node = this.own(ctx.createDelay(10))
        node.delayTime.value = effect.seconds
        const feedback = this.own(ctx.createGain())
        feedback.gain.value = effect.feedback
        node.connect(feedback).connect(node)
        this.bind(`${key}seconds`, node.delayTime)
        this.bind(`${key}feedback`, feedback.gain)
        return { input: node, output: node }
      }
      case 'reverb': {
        if (!effect.ir || effect.ir.stream)
          throw new ShardError('audio/invalid-effect', 'Reverb requires a decoded impulse response')
        const lease = await cache.acquire(effect.ir)
        this.leases.push(lease)
        if (!lease.value.buffer || ![1, 2, 4].includes(lease.channels)) {
          throw new ShardError('audio/invalid-effect', 'Impulse responses need 1, 2 or 4 channels')
        }
        const node = this.own(ctx.createConvolver())
        node.normalize = false
        node.buffer = lease.value.buffer
        return { input: node, output: node }
      }
    }
  }

  private async chain(bus: AudioBusDesc, cache: Pick<AudioCache, 'acquire'>) {
    const input = this.own(this.context.createGain())
    let tail: AudioNode = input
    for (const effect of bus.effects) {
      const insert = await this.effect(bus.id, effect, cache)
      tail.connect(insert.input)
      tail = insert.output
    }
    const fader = this.own(this.context.createGain())
    fader.gain.value = bus.gain
    tail.connect(fader)
    this.bind(`${bus.id}/gain`, fader.gain)
    return { input, pre: tail, post: fader }
  }

  static async build(
    context: BaseAudioContext,
    graph: AudioMixerGraph,
    output: GainNode,
    cache: Pick<AudioCache, 'acquire'>,
  ): Promise<WebAudioGraph> {
    const result = new WebAudioGraph(context, graph, output)
    try {
      const master = result.buses.get('master')
      if (!master) throw new ShardError('audio/invalid-effect', 'Mixer needs a master bus')
      const root = await result.chain(master, cache)
      const masterUser = result.own(context.createGain())
      masterUser.gain.value = master.userGain
      root.post.connect(masterUser).connect(output)
      result.bind('master/userGain', masterUser.gain)
      const masterInput = result.own(context.createGain())
      masterInput.connect(root.input)
      result.inputs.set('master', masterInput)
      result.outputs.set('master', masterUser)
      if (
        master.sends.length ||
        master.effects.some((e) => e.kind === 'delay' || e.kind === 'reverb')
      ) {
        throw new ShardError(
          'audio/invalid-effect',
          'Master cannot own sends or stateful wet effects; put these inside a user-control domain',
        )
      }
      const ordinary = new Map<string, Awaited<ReturnType<WebAudioGraph['chain']>>>()
      for (const bus of graph.buses) {
        if (bus.return || bus.id === 'master') continue
        const chain = await result.chain(bus, cache)
        ordinary.set(bus.id, chain)
        const input = result.own(context.createGain())
        input.connect(chain.input)
        result.inputs.set(bus.id, input)
        result.outputs.set(bus.id, chain.post)
      }
      const returns = new Map<string, Awaited<ReturnType<WebAudioGraph['chain']>>>()
      const visiting = new Set<string>()
      const routeReturn = async (id: string, domain: string): Promise<AudioNode> => {
        if (id === 'master') return result.gates.get(domain)!
        const key = `${domain}/${id}`
        if (visiting.has(key)) throw new ShardError('audio/mixer-cycle', `Return cycle at ${id}`)
        const existing = returns.get(key)
        if (existing) return existing.input
        const bus = result.buses.get(id)
        if (!bus?.return)
          throw new ShardError('audio/unknown-bus', `Send destination ${id} must be a return`)
        visiting.add(key)
        const nodes = await result.chain(bus, cache)
        returns.set(key, nodes)
        let meter = result.outputs.get(id)
        if (!meter) {
          meter = result.own(context.createGain())
          result.outputs.set(id, meter)
        }
        const returnUser = result.own(context.createGain())
        returnUser.gain.value = bus.userGain
        result.bind(`${bus.id}/userGain`, returnUser.gain)
        nodes.post.connect(returnUser).connect(meter)
        returnUser.connect(await routeReturn(bus.parent, domain))
        for (const send of bus.sends) {
          const gain = result.own(context.createGain())
          gain.gain.value = send.gain
          ;(send.pre ? nodes.pre : nodes.post)
            .connect(gain)
            .connect(await routeReturn(send.target, domain))
          result.bind(`${id}/send/${send.target}`, gain.gain)
        }
        visiting.delete(key)
        return nodes.input
      }
      for (const bus of graph.buses) {
        if (bus.return || bus.id === 'master') continue
        const path: string[] = []
        let parent = bus.id
        while (parent !== 'master') {
          if (path.includes(parent))
            throw new ShardError('audio/mixer-cycle', `Parent cycle at ${parent}`)
          path.push(parent)
          const ancestor = result.buses.get(parent)
          if (!ancestor || ancestor.return || !ancestor.parent)
            throw new ShardError('audio/unknown-bus', `Invalid parent ${parent}`)
          parent = ancestor.parent
        }
        const domain = path[path.length - 1]!
        if (!result.gates.has(domain)) {
          const gate = result.own(context.createGain())
          gate.connect(root.input)
          result.gates.set(domain, gate)
          result.ancestry.set(domain, [domain])
        }
        const nodes = ordinary.get(bus.id)!
        if (bus.id === domain) nodes.post.connect(result.gates.get(domain)!)
        else {
          const user = result.own(context.createGain())
          user.gain.value = bus.userGain
          result.bind(`${bus.id}/userGain`, user.gain)
          nodes.post.connect(user).connect(ordinary.get(bus.parent)!.input)
        }
        for (const send of bus.sends) {
          const gain = result.own(context.createGain())
          gain.gain.value = send.gain
          ;(send.pre ? nodes.pre : nodes.post)
            .connect(gain)
            .connect(await routeReturn(send.target, domain))
          result.bind(`${bus.id}/send/${send.target}`, gain.gain)
        }
      }
      result.refreshGates()
      return result
    } catch (error) {
      result.dispose()
      throw error
    }
  }

  private refreshGates(seconds = 0): void {
    for (const [origin, gate] of this.gates) {
      let gain = 1
      for (const bus of this.ancestry.get(origin)!) gain *= this.userGains.get(bus) ?? 1
      ramp(gate.gain, gain, this.context.currentTime, seconds)
    }
  }

  set(bus: string, field: string, value: number, seconds: number): void {
    if (field === 'userGain' && this.gates.has(bus)) {
      this.userGains.set(bus, value)
      this.refreshGates(seconds)
      return
    }
    const params = this.values.get(`${bus}/${field}`)
    if (!params) throw new ShardError('audio/invalid-effect', `No mixer target ${bus}/${field}`)
    for (const param of params) ramp(param, value, this.context.currentTime, seconds)
  }

  dispose(): void {
    for (const node of this.nodes) node.disconnect()
    for (const lease of this.leases) lease.release()
    this.nodes.length = 0
    this.leases.length = 0
  }
}
