import { ShardError } from '@aethervtt/shard-core'
import type { Channel, ConnectionStats, NetConnection, PeerId } from '@aethervtt/shard-net'
import type { SignalData } from './protocol'

/**
 * One peer as a net connection (0091): two negotiated data channels, `reliable` (id 0, ordered)
 * and `unreliable` (id 1, unordered, no retransmits). Negotiated ids mean both sides create the
 * same channels and neither waits for `ondatachannel`.
 */
export class WebRtcConnection implements NetConnection {
  readonly peer: PeerId
  readonly pc: RTCPeerConnection
  /** Resolves when both channels are open; rejects if the connection fails first. */
  readonly opened: Promise<void>
  private readonly channels: [RTCDataChannel, RTCDataChannel]
  private readonly maxMessage: number
  private readonly messageFns: ((channel: Channel, bytes: Uint8Array) => void)[] = []
  private readonly closeFns: ((reason: ShardError | undefined) => void)[] = []
  private readonly counters: ConnectionStats = { rtt: 0, sentBytes: 0, receivedBytes: 0, lost: 0 }
  private closed = false
  private closing = false
  private readonly cleanup: (() => void)[] = []

  constructor(pc: RTCPeerConnection, peer: PeerId, maxMessage: number) {
    this.pc = pc
    this.peer = peer
    this.maxMessage = maxMessage
    const reliable = pc.createDataChannel('reliable', { negotiated: true, id: 0, ordered: true })
    const unreliable = pc.createDataChannel('unreliable', {
      negotiated: true,
      id: 1,
      ordered: false,
      maxRetransmits: 0,
    })
    this.channels = [reliable, unreliable]
    let open = 0
    let settle: { resolve(): void; reject(e: ShardError): void } | undefined
    this.opened = new Promise<void>((resolve, reject) => {
      settle = { resolve, reject }
    })
    // Nobody may await `opened` (a connection that fails before use): don't leak a rejection.
    this.opened.catch(() => {})
    const names: Channel[] = ['reliable', 'unreliable']
    this.channels.forEach((dc, i) => {
      dc.binaryType = 'arraybuffer'
      dc.onopen = () => {
        if (++open === 2) settle?.resolve()
      }
      dc.onmessage = (event: MessageEvent) => {
        const data = event.data
        const bytes =
          data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : ArrayBuffer.isView(data)
              ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
              : undefined
        if (!bytes) return
        this.counters.receivedBytes += bytes.length
        for (const fn of this.messageFns) fn(names[i]!, bytes)
      }
      dc.onclose = () => this.fail('A data channel closed')
    })
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState
      if (state === 'failed' || state === 'closed') this.fail(`WebRTC connection ${state}`)
    }
    this.cleanup.push(() => settle?.reject(failed('The connection closed before it opened')))
  }

  /** Runs when the connection ends either way (closes the peer's lobby socket). */
  onEnd(fn: () => void): void {
    this.cleanup.push(fn)
  }

  private fail(message: string): void {
    this.shut(this.closing ? undefined : failed(message))
  }

  send(channel: Channel, bytes: Uint8Array): void {
    if (this.closed) return
    if (bytes.length > this.maxMessage) {
      throw new ShardError(
        'net/message-too-large',
        `A ${bytes.length}-byte message is over ${this.maxMessage} bytes`,
        {
          hint: 'Reliable messages are split automatically; keep unreliable ones under maxMessage.',
        },
      )
    }
    const dc = this.channels[channel === 'reliable' ? 0 : 1]
    if (dc.readyState !== 'open') return
    this.counters.sentBytes += bytes.length
    try {
      // send() copies the data; slice() makes an exact ArrayBuffer for implementations that want one.
      dc.send(bytes.slice())
    } catch {
      // The channel closed under us: the close handler reports it.
      this.fail('A data channel closed while sending')
    }
  }

  onMessage(fn: (channel: Channel, bytes: Uint8Array) => void): () => void {
    this.messageFns.push(fn)
    return () => remove(this.messageFns, fn)
  }

  onClose(fn: (reason: ShardError | undefined) => void): () => void {
    this.closeFns.push(fn)
    return () => remove(this.closeFns, fn)
  }

  /**
   * Closes gracefully: no more sends, then the channels close once what's queued has gone out (a
   * goodbye message arrives before the close), and the peer connection after them.
   */
  close(): void {
    if (this.closed) return
    this.closing = true
    this.shut(undefined, true)
  }

  private shut(reason: ShardError | undefined, graceful = false): void {
    if (this.closed) return
    this.closed = true
    const teardown = () => {
      for (const dc of this.channels) dc.close()
      // A channel close is ordered after its data; give it a moment before dropping the transport.
      setTimeout(() => this.pc.close(), graceful ? LINGER_MS : 0)
    }
    if (graceful) drain(this.channels, teardown)
    else teardown()
    for (const fn of this.cleanup.splice(0)) fn()
    for (const fn of [...this.closeFns]) fn(reason)
  }

  stats(): ConnectionStats {
    return { ...this.counters }
  }
}

const LINGER_MS = 250
const DRAIN_LIMIT_MS = 1000

/** Calls `done` once both channels have sent what's buffered (or a second has passed). */
function drain(channels: readonly RTCDataChannel[], done: () => void): void {
  const start = Date.now()
  const check = () => {
    const queued = channels.some((dc) => dc.readyState === 'open' && dc.bufferedAmount > 0)
    if (!queued || Date.now() - start > DRAIN_LIMIT_MS) done()
    else setTimeout(check, 10)
  }
  check()
}

export function failed(message: string): ShardError {
  return new ShardError('net/webrtc-failed', message, {
    hint: 'Peers on different networks need STUN (and TURN behind strict NATs) in iceServers.',
  })
}

function remove<T>(list: T[], item: T): void {
  const i = list.indexOf(item)
  if (i !== -1) list.splice(i, 1)
}

/**
 * Runs one side of the offer/answer exchange. The joiner offers; the host answers. Candidates
 * that arrive before the remote description wait for it.
 */
export class Negotiation {
  private readonly pc: RTCPeerConnection
  private readonly send: (data: SignalData) => void
  private readonly pending: RTCIceCandidateInit[] = []
  private remoteSet = false
  private chain: Promise<void> = Promise.resolve()
  error: ShardError | undefined

  constructor(pc: RTCPeerConnection, send: (data: SignalData) => void) {
    this.pc = pc
    this.send = send
    pc.onicecandidate = (event) => {
      const c = event.candidate
      if (!c?.candidate) return
      send({
        candidate: { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex },
      })
    }
  }

  /** Joiner: make and send the offer. */
  offer(): void {
    this.queue(async () => {
      const offer = await this.pc.createOffer()
      await this.pc.setLocalDescription(offer)
      this.sendDescription()
    })
  }

  /** Handles what the other side sent, in arrival order. */
  receive(data: SignalData): void {
    this.queue(async () => {
      if ('sdp' in data) {
        await this.pc.setRemoteDescription(data.sdp as RTCSessionDescriptionInit)
        this.remoteSet = true
        for (const c of this.pending.splice(0)) await this.pc.addIceCandidate(c)
        if (data.sdp.type === 'offer') {
          const answer = await this.pc.createAnswer()
          await this.pc.setLocalDescription(answer)
          this.sendDescription()
        }
      } else if (this.remoteSet) {
        await this.pc.addIceCandidate(data.candidate)
      } else this.pending.push(data.candidate)
    })
  }

  private sendDescription(): void {
    const d = this.pc.localDescription
    if (d) this.send({ sdp: { type: d.type, sdp: d.sdp } })
  }

  private queue(step: () => Promise<void>): void {
    this.chain = this.chain.then(step).catch((err: unknown) => {
      this.error = failed(err instanceof Error ? err.message : String(err))
      this.pc.close()
    })
  }
}
