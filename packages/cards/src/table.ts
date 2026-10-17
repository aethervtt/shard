import {
  type AssetRef,
  defineResource,
  type Entity,
  ShardError,
  type World,
} from '@aethervtt/shard-core'
import type { Mesh } from '@aethervtt/shard-mesh'
import {
  Gpu,
  GpuAssetsResource,
  InstanceData,
  MaterialAsset,
  Materials,
  type MaterialType,
  Mesh3d,
  Meshes,
  MeshMaterial,
  reportUnsupported,
} from '@aethervtt/shard-render'
import { FrameDemand } from '@aethervtt/shard-runtime'
import { Texture, Textures } from '@aethervtt/shard-texture'
import { Transform } from '@aethervtt/shard-transform'
import {
  Card,
  CardDefinition,
  type CardDefinitionValue,
  type CardFace,
  CardInteraction,
} from './definition'
import type { CardFinish } from './finishes'
import { cardMesh } from './mesh'
import { CardAutomaticMotion, type CardAutomaticMotionValue, sampleCardMotion } from './motion'
import type { CardTexturePage } from './textures'

const WIDTH = 64
const FLOATS = WIDTH * 4
const HALF_BYTES = FLOATS * 2
const halfFloat = new Float32Array(1)
const halfBits = new Uint32Array(halfFloat.buffer)

export interface CardPose {
  x: number
  y: number
  z: number
  pitch?: number
  yaw?: number
  roll?: number
  scale?: number
}
export interface CardHit {
  card: CardHandle | undefined
  side: 'front' | 'back' | 'edge'
  u: number
  v: number
  distance: number
}
export const createCardHit = (): CardHit => ({
  card: undefined,
  side: 'front',
  u: 0,
  v: 0,
  distance: Infinity,
})

export class CardHandle {
  readonly slot: number
  readonly entity: Entity
  readonly instanceId: string
  readonly definition: CardDefinitionValue
  readonly table: CardTableState
  readonly pose = new Float64Array(7)
  readonly target = new Float64Array(7)
  readonly start = new Float64Array(7)
  readonly translation = [0, 0, 0] as [number, number, number]
  readonly rotation = [0, 0, 0, 1] as [number, number, number, number]
  readonly scale = [1, 1, 1] as [number, number, number]
  readonly transform = { translation: this.translation, rotation: this.rotation, scale: this.scale }
  readonly data: Float32Array
  readonly bytes: Uint8Array<ArrayBuffer>
  readonly halfView: DataView
  active = true
  interactive = true
  tilt = false
  automaticTilt = false
  maxTilt = 8
  hoverX = 0
  hoverY = 0
  hovered = false
  tiltX = 0
  tiltY = 0
  duration = 0
  age = 0
  poseDirty = true
  dataDirty = true
  animationFps = 0
  constructor(
    table: CardTableState,
    slot: number,
    entity: Entity,
    id: string,
    definition: CardDefinitionValue,
  ) {
    this.table = table
    this.slot = slot
    this.entity = entity
    this.instanceId = id
    this.definition = definition
    this.data = new Float32Array(FLOATS)
    this.bytes = new Uint8Array(table.recordBytes.buffer, slot * HALF_BYTES, HALF_BYTES)
    this.halfView = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength)
    this.pose[6] = this.target[6] = 1
  }
  setPose(pose: CardPose, seconds = 0): void {
    this.start.set(this.pose)
    this.target[0] = pose.x
    this.target[1] = pose.y
    this.target[2] = pose.z
    this.target[3] = pose.pitch ?? 0
    this.target[4] = pose.yaw ?? 0
    this.target[5] = pose.roll ?? 0
    this.target[6] = pose.scale ?? 1
    this.duration = this.table.reducedMotion ? 0 : Math.max(0, seconds)
    this.age = 0
    if (!this.duration) this.pose.set(this.target)
    this.poseDirty = true
    this.table.wake()
  }
  flip(seconds = 0.65): void {
    this.start.set(this.pose)
    this.target.set(this.pose)
    this.target[4] = Math.round(this.target[4]! / 180 + 1) * 180
    this.duration = this.table.reducedMotion ? 0 : seconds
    this.age = 0
    if (!this.duration) this.pose.set(this.target)
    this.poseDirty = true
    this.table.wake()
  }
  setHover(u: number, v: number, active: boolean): void {
    const x = Math.max(-1, Math.min(1, u * 2 - 1))
    const y = Math.max(-1, Math.min(1, v * 2 - 1))
    if (this.hoverX === x && this.hoverY === y && this.hovered === active) return
    this.hoverX = x
    this.hoverY = y
    this.hovered = active
    this.data[8] = this.hoverX
    this.data[9] = this.hoverY
    this.data[10] = Number(active)
    this.dataDirty = true
    this.table.wake()
  }
  /** Replaces the automatic driver settings; no per-frame instance uploads for foil-only motion. */
  setAutomaticMotion(options: Partial<CardAutomaticMotionValue>): void {
    const motion = CardAutomaticMotion.deserialize({
      phase: (this.slot * 0.625) % 1024,
      ...options,
    })
    // Binary steps keep CPU tilt and the half-float shader record on the same path.
    const enabled = Number(motion.enabled)
    const seconds = Math.round(motion.seconds * 32) / 32
    const range = Math.round(motion.range * 1024) / 1024
    const phase = Math.round(motion.phase * 2) / 2
    if (
      this.automaticTilt === motion.tilt &&
      this.data[12] === enabled &&
      this.data[13] === seconds &&
      this.data[14] === range &&
      this.data[15] === phase
    )
      return
    this.automaticTilt = motion.tilt
    this.data[12] = enabled
    this.data[13] = seconds
    this.data[14] = range
    this.data[15] = phase
    this.dataDirty = true
    this.table.wake()
  }
  setStrength(value: number, layer?: number, side: 'front' | 'back' = 'front'): void {
    const amount = Math.max(0, Math.min(2, value))
    if (layer === undefined) this.data[0] = amount
    else {
      if (!Number.isInteger(layer) || layer < 0 || layer > 3)
        throw new ShardError('cards/invalid-layer', 'Layer must be 0–3')
      this.data[((side === 'front' ? 4 : 24) + 3 + layer * 4) * 4 + 1] = Math.min(1, amount)
    }
    this.dataDirty = true
    this.table.wake()
  }
  setFinish(
    layer: number,
    name: string,
    parameters: Record<string, unknown> = {},
    side: 'front' | 'back' = 'front',
  ): void {
    this.table.finish(this, layer, name, parameters, side)
  }
  dispose(): void {
    this.table.remove(this)
  }
}

export class CardTableState {
  readonly world: World
  readonly finishes: readonly CardFinish[]
  readonly cards: (CardHandle | undefined)[] = []
  readonly recordBytes: Uint8Array<ArrayBuffer>
  readonly records: Texture
  readonly material: MaterialAsset
  readonly materialRef: AssetRef<'Material'>
  readonly art: CardTexturePage
  readonly masks: CardTexturePage
  readonly capacity: number
  readonly byId = new Map<string, CardHandle>()
  private readonly definitionRefs = new Map<CardDefinitionValue, AssetRef<'cards/CardDefinition'>>()
  private readonly meshes = new Map<string, { mesh: Mesh; ref: AssetRef<'Mesh'> }>()
  private readonly free: number[] = []
  private readonly textureRefs: AssetRef<'Texture'>[]
  private readonly dirtyOrigin = { x: 0, y: 0, z: 0 }
  private readonly writeTarget: GPUTexelCopyTextureInfo = {
    texture: null as unknown as GPUTexture,
    origin: this.dirtyOrigin,
  }
  private readonly writeLayout = { bytesPerRow: HALF_BYTES, rowsPerImage: 1 }
  private readonly writeSize = { width: WIDTH, height: 1, depthOrArrayLayers: 1 }
  private disposed = false
  private automaticTime = 0
  private readonly automaticPoint = new Float32Array(2)
  reducedMotion = false
  animated = false
  uploadedBytes = 0
  constructor(
    world: World,
    finishes: readonly CardFinish[],
    type: MaterialType,
    art: CardTexturePage,
    masks: CardTexturePage,
    capacity = 1024,
    budgetMiB = 128,
  ) {
    this.world = world
    this.finishes = finishes
    this.art = art
    this.masks = masks
    this.capacity = Math.min(2048, Math.max(1, Math.floor(capacity)))
    this.recordBytes = new Uint8Array(this.capacity * HALF_BYTES)
    this.records = Texture.create({
      width: WIDTH,
      height: this.capacity,
      format: 'rgba16float',
      usage: 'data',
      mips: [this.recordBytes],
    })
    if (
      art.texture.byteSize + masks.texture.byteSize + this.records.byteSize >
      budgetMiB * 1024 * 1024
    ) {
      throw new ShardError('cards/texture-budget', `Card textures exceed ${budgetMiB} MiB`)
    }
    const textures = world.resource(Textures)
    this.textureRefs = [
      textures.add(art.texture),
      textures.add(masks.texture),
      textures.add(this.records),
    ]
    this.material = new MaterialAsset(
      {
        ...(type.standard ? { baseColor: [1, 1, 1, 1] } : {}),
        art: this.textureRefs[0],
        masks: this.textureRefs[1],
        records: this.textureRefs[2],
      },
      type,
    )
    this.materialRef = world.resource(Materials).add(this.material, 'cards/batch')
  }
  wake(): void {
    this.world.tryResource(FrameDemand)?.after(0)
  }
  spawn(definition: CardDefinitionValue, instanceId: string, pose?: CardPose): CardHandle {
    if (this.disposed) throw new ShardError('cards/disposed', 'The card table has been disposed')
    if (this.byId.has(instanceId)) throw new ShardError('cards/duplicate-id', instanceId)
    const slot = this.free.length ? this.free.pop()! : this.cards.length
    if (slot >= this.capacity)
      throw new ShardError('cards/capacity', `Only ${this.capacity} cards can be exposed at once`)
    const key = `${definition.size[0]}:${definition.size[1]}:${definition.cornerRadius}:${definition.thickness}`
    let mesh = this.meshes.get(key)
    if (!mesh) {
      const value = cardMesh(definition)
      mesh = { mesh: value, ref: this.world.resource(Meshes).add(value) }
      this.meshes.set(key, mesh)
    }
    let definitionRef = this.definitionRefs.get(definition)
    if (!definitionRef) {
      definitionRef = this.world.resource(CardDefinition.store).add(definition)
      this.definitionRefs.set(definition, definitionRef)
    }
    const entity = this.world.spawn(
      [Card, { instanceId, definition: definitionRef }],
      CardInteraction,
      [Mesh3d, { mesh: mesh.ref }],
      [MeshMaterial, { material: this.materialRef }],
      [InstanceData, { x: slot, y: 0 }],
      Transform,
    )
    const card = new CardHandle(this, slot, entity, instanceId, definition)
    this.cards[slot] = card
    this.byId.set(instanceId, card)
    card.data[0] = 1
    card.data[2] = definition.size[0] / definition.size[1]
    card.data[3] = slot * 0.17
    for (let i = 0; i < 4; i++) card.data[4 + i] = definition.edgeColor[i]!
    this.face(card, definition.front, 4)
    this.face(card, definition.back, 24)
    if (pose) card.setPose(pose)
    this.wake()
    return card
  }
  private face(card: CardHandle, face: CardFace, start: number): void {
    const d = card.data
    const artId = face.art?.path ?? face.art?.guid ?? ''
    const index = this.art.indices.get(artId) ?? 0
    d[start * 4] = index
    d[start * 4 + 1] = ['contain', 'cover', 'stretch'].indexOf(face.fit)
    d[start * 4 + 2] = this.art.aspects[index] ?? card.data[2]!
    d[start * 4 + 3] = face.rotation
    for (let k = 0; k < 4; k++) {
      d[(start + 1) * 4 + k] = face.uvRect[k]!
      d[(start + 2) * 4 + k] = face.background[k]!
    }
    for (let i = 0; i < 4; i++) {
      const layer = face.finishes[i]
      const offset = (start + 3 + i * 4) * 4
      d[offset + 8] = d[offset + 9] = 1
      if (!layer) continue
      d[offset + 1] = layer.strength
      const maskId = layer.mask.texture?.path ?? layer.mask.texture?.guid ?? ''
      d[offset + 2] = this.masks.indices.get(maskId) ?? 0
      d[offset + 8] = layer.mask.scale[0]
      d[offset + 9] = layer.mask.scale[1]
      d[offset + 10] = layer.mask.offset[0]
      d[offset + 11] = layer.mask.offset[1]
      d[offset + 12] = ['r', 'g', 'b', 'a'].indexOf(layer.mask.channel)
      d[offset + 13] = Number(layer.mask.invert)
      d[offset + 14] = Number(layer.mask.space === 'art')
      this.finish(
        card,
        i,
        layer.family,
        layer.parameters as Record<string, unknown>,
        start === 4 ? 'front' : 'back',
      )
    }
  }
  finish(
    card: CardHandle,
    layer: number,
    name: string,
    parameters: Record<string, unknown>,
    side: 'front' | 'back',
  ): void {
    if (!Number.isInteger(layer) || layer < 0 || layer > 3)
      throw new ShardError('cards/invalid-layer', 'Layer must be 0–3')
    const index = this.finishes.findIndex((f) => f.name === name)
    if (index < 0) throw new ShardError('cards/unknown-finish', `Unknown foil family: ${name}`)
    const finish = this.finishes[index]!
    if (finish.options.baseline === 'unsupported' && this.world.resource(Gpu).tier === 'baseline') {
      reportUnsupported(
        this.world,
        name,
        `Card finish ${name} is unavailable on the baseline tier; showing the underlying print.`,
      )
    }
    const value = finish.schema.deserialize(parameters) as Record<string, number>
    const offset = ((side === 'front' ? 4 : 24) + 3 + layer * 4) * 4
    card.data[offset] = index + 1
    for (let i = 0; i < 4; i++)
      card.data[offset + 4 + i] = i < finish.keys.length ? value[finish.keys[i]!]! : 0
    card.animationFps = 0
    for (let face = 0; face < 2; face++)
      for (let l = 0; l < 4; l++) {
        const family = card.data[((face === 0 ? 4 : 24) + 3 + l * 4) * 4]!
        const animated = this.finishes[family - 1]?.options.animated
        if (animated) card.animationFps = Math.max(card.animationFps, animated.fps)
      }
    card.dataDirty = true
    this.wake()
  }
  configure(values: {
    maskView?: number
    gloss?: number
    luminance?: number
    light?: readonly number[]
  }): void {
    this.material.set(values)
    this.wake()
  }
  update(delta: number, elapsed: number): void {
    if (this.disposed) return
    let moving = false
    let dirty = false
    let animationFps = this.animated ? 60 : 0
    let automatic = false
    if (!this.reducedMotion) this.automaticTime += Math.max(0, Math.min(delta, 0.1))
    this.uploadedBytes = 0
    for (let i = 0; i < this.cards.length; i++) {
      const card = this.cards[i]
      if (!card?.active) continue
      animationFps = Math.max(animationFps, card.animationFps)
      if (!this.world.isAlive(card.entity)) {
        this.remove(card)
        continue
      }
      if (card.duration > 0) {
        card.age += delta
        const t = this.reducedMotion ? 1 : Math.min(1, card.age / card.duration)
        const ease = t * t * (3 - 2 * t)
        for (let k = 0; k < 7; k++)
          card.pose[k] = card.start[k]! + (card.target[k]! - card.start[k]!) * ease
        if (t === 1) card.duration = 0
        card.poseDirty = true
        moving = true
      }
      const auto = card.data[12]! > 0.5
      if (auto) {
        automatic = true
        animationFps = Math.max(animationFps, 60)
      }
      const on = !this.reducedMotion && (auto ? card.automaticTilt : card.tilt && card.hovered)
      let px = card.hoverX,
        py = card.hoverY
      if (auto && on) {
        sampleCardMotion(
          Math.fround(this.automaticTime),
          card.data[13]!,
          card.data[14]!,
          card.data[15]!,
          this.automaticPoint,
        )
        px = this.automaticPoint[0]!
        py = this.automaticPoint[1]!
      }
      const tx = on ? -py * card.maxTilt : 0,
        ty = on ? px * card.maxTilt : 0
      const damping = 1 - Math.exp(-Math.min(delta, 0.05) / (on ? 0.12 : 0.18))
      if (Math.abs(card.tiltX - tx) + Math.abs(card.tiltY - ty) > 0.005) {
        card.tiltX += (tx - card.tiltX) * damping
        card.tiltY += (ty - card.tiltY) * damping
        moving = true
        card.poseDirty = true
      } else if (card.tiltX !== tx || card.tiltY !== ty) {
        card.tiltX = tx
        card.tiltY = ty
        card.poseDirty = true
      }
      if (card.poseDirty) {
        card.poseDirty = false
        const x = ((card.pose[3]! + card.tiltX) * Math.PI) / 360
        const y = ((card.pose[4]! + card.tiltY) * Math.PI) / 360
        const z = (card.pose[5]! * Math.PI) / 360
        const sx = Math.sin(x),
          cx = Math.cos(x),
          sy = Math.sin(y),
          cy = Math.cos(y),
          sz = Math.sin(z),
          cz = Math.cos(z)
        card.rotation[0] = sx * cy * cz + cx * sy * sz
        card.rotation[1] = cx * sy * cz - sx * cy * sz
        card.rotation[2] = cx * cy * sz + sx * sy * cz
        card.rotation[3] = cx * cy * cz - sx * sy * sz
        for (let k = 0; k < 3; k++) {
          card.translation[k] = card.pose[k]!
          card.scale[k] = card.pose[6]!
        }
        this.world.set(card.entity, Transform, card.transform)
      }
      if (card.dataDirty) dirty = true
    }
    if (dirty) this.flush()
    const animating = animationFps > 0 && !this.reducedMotion && this.byId.size > 0
    if (animating) {
      this.material.value.clock = elapsed
      if (automatic) this.material.value.automaticClock = this.automaticTime
      this.material.version++
    }
    const demand = this.world.tryResource(FrameDemand)
    demand?.set('cards/motion', moving)
    if (animating) demand?.after(1000 / animationFps)
  }
  private flush(): void {
    const assets = this.world.tryResource(GpuAssetsResource)
    const gpu = assets?.texture(this.records)
    if (!assets || !gpu) return
    this.writeTarget.texture = gpu.texture
    for (let i = 0; i < this.cards.length; i++) {
      const card = this.cards[i]
      if (!card?.dataDirty) continue
      const out = card.halfView
      for (let j = 0; j < FLOATS; j++) {
        halfFloat[0] = card.data[j]!
        const bits = halfBits[0]!,
          sign = (bits >>> 16) & 0x8000,
          exponent = ((bits >>> 23) & 255) - 112
        const half =
          exponent <= 0
            ? sign
            : exponent >= 31
              ? sign | 0x7bff
              : sign | (exponent << 10) | ((bits & 0x7fffff) >>> 13)
        out.setUint16(j * 2, half, true)
      }
      this.dirtyOrigin.y = i
      assets.gpu.device.queue.writeTexture(
        this.writeTarget,
        card.bytes,
        this.writeLayout,
        this.writeSize,
      )
      this.uploadedBytes += HALF_BYTES
      card.dataDirty = false
    }
  }
  remove(card: CardHandle): void {
    if (!card.active) return
    card.active = false
    if (this.world.isAlive(card.entity)) this.world.despawn(card.entity)
    this.cards[card.slot] = undefined
    this.byId.delete(card.instanceId)
    this.free.push(card.slot)
    this.wake()
  }
  describe() {
    return {
      cards: this.byId.size,
      capacity: this.capacity,
      finishes: this.finishes.map((f) => f.name),
      textureBytes: this.art.texture.byteSize + this.masks.texture.byteSize + this.records.byteSize,
      uploadedBytes: this.uploadedBytes,
      reducedMotion: this.reducedMotion,
    }
  }
  dispose(): void {
    if (this.disposed) return
    for (let i = 0; i < this.cards.length; i++) if (this.cards[i]) this.remove(this.cards[i]!)
    const assets = this.world.tryResource(GpuAssetsResource)
    assets?.releaseMaterial(this.material)
    this.world.resource(Materials).delete(this.materialRef.guid!)
    assets?.releaseTexture(this.records)
    // Art and masks may be shared by another view; their GPU lifetime belongs to the host.
    for (const ref of this.textureRefs) this.world.resource(Textures).delete(ref.guid!)
    for (const ref of this.definitionRefs.values())
      this.world.resource(CardDefinition.store).delete(ref.guid!)
    this.definitionRefs.clear()
    for (const entry of this.meshes.values()) {
      assets?.releaseMesh(entry.mesh)
      this.world.resource(Meshes).delete(entry.ref.guid!)
    }
    this.world.tryResource(FrameDemand)?.release('cards/motion')
    this.disposed = true
  }
}

export const Cards = defineResource<CardTableState>('cards/Table', {
  description: 'Exposed cards, finish library and shared GPU pages.',
})

/** Project against the authored pose, excluding hover tilt, to prevent pointer feedback. */
export function cardTiltCoordinates(
  card: CardHandle,
  origin: ArrayLike<number>,
  direction: ArrayLike<number>,
  out: Float64Array,
): boolean {
  const ax = (card.pose[3]! * Math.PI) / 360,
    ay = (card.pose[4]! * Math.PI) / 360,
    az = (card.pose[5]! * Math.PI) / 360
  const sx = Math.sin(ax),
    cx = Math.cos(ax),
    sy = Math.sin(ay),
    cy = Math.cos(ay),
    sz = Math.sin(az),
    cz = Math.cos(az)
  const x = sx * cy * cz + cx * sy * sz,
    y = cx * sy * cz - sx * cy * sz
  const z = cx * cy * sz + sx * sy * cz,
    w = cx * cy * cz - sx * sy * sz
  const m00 = 1 - 2 * (y * y + z * z),
    m10 = 2 * (x * y + w * z),
    m20 = 2 * (x * z - w * y)
  const m01 = 2 * (x * y - w * z),
    m11 = 1 - 2 * (x * x + z * z),
    m21 = 2 * (y * z + w * x)
  const m02 = 2 * (x * z + w * y),
    m12 = 2 * (y * z - w * x),
    m22 = 1 - 2 * (x * x + y * y)
  const ox = origin[0]! - card.pose[0]!,
    oy = origin[1]! - card.pose[1]!,
    oz = origin[2]! - card.pose[2]!
  const dx = direction[0]!,
    dy = direction[1]!,
    dz = direction[2]!
  const rayZ = dx * m02 + dy * m12 + dz * m22
  if (Math.abs(rayZ) < 1e-8) return false
  const distance = -(ox * m02 + oy * m12 + oz * m22) / rayZ
  if (distance < 0) return false
  out[0] =
    0.5 +
    (ox * m00 + oy * m10 + oz * m20 + distance * (dx * m00 + dy * m10 + dz * m20)) /
      (card.pose[6]! * card.definition.size[0])
  out[1] =
    0.5 -
    (ox * m01 + oy * m11 + oz * m21 + distance * (dx * m01 + dy * m11 + dz * m21)) /
      (card.pose[6]! * card.definition.size[1])
  return true
}

/** Camera-independent exact rounded face query; writes into caller-owned storage. */
export function hitCards(
  table: CardTableState,
  origin: ArrayLike<number>,
  direction: ArrayLike<number>,
  out: CardHit,
): boolean {
  out.card = undefined
  out.distance = Infinity
  for (let i = 0; i < table.cards.length; i++) {
    const card = table.cards[i]
    if (!card?.active || !card.interactive) continue
    const q = card.rotation,
      x = q[0],
      y = q[1],
      z = q[2],
      w = q[3]
    const m00 = 1 - 2 * (y * y + z * z),
      m10 = 2 * (x * y + w * z),
      m20 = 2 * (x * z - w * y)
    const m01 = 2 * (x * y - w * z),
      m11 = 1 - 2 * (x * x + z * z),
      m21 = 2 * (y * z + w * x)
    const m02 = 2 * (x * z + w * y),
      m12 = 2 * (y * z - w * x),
      m22 = 1 - 2 * (x * x + y * y)
    const ox = origin[0]! - card.translation[0],
      oy = origin[1]! - card.translation[1],
      oz = origin[2]! - card.translation[2]
    const dx = direction[0]!,
      dy = direction[1]!,
      dz = direction[2]!
    const localZ = ox * m02 + oy * m12 + oz * m22,
      rayZ = dx * m02 + dy * m12 + dz * m22
    if (Math.abs(rayZ) < 1e-8) continue
    const scale = card.pose[6]!
    const side = rayZ < 0 ? 1 : -1
    const distance = ((side * card.definition.thickness * scale) / 2 - localZ) / rayZ
    if (distance < 0 || distance >= out.distance) continue
    const px =
      (ox * m00 + oy * m10 + oz * m20 + distance * (dx * m00 + dy * m10 + dz * m20)) / scale
    const py =
      (ox * m01 + oy * m11 + oz * m21 + distance * (dx * m01 + dy * m11 + dz * m21)) / scale
    const hw = card.definition.size[0] / 2,
      hh = card.definition.size[1] / 2,
      r = card.definition.cornerRadius
    const ax = Math.max(Math.abs(px) - hw + r, 0),
      ay = Math.max(Math.abs(py) - hh + r, 0)
    if (Math.abs(px) > hw || Math.abs(py) > hh || ax * ax + ay * ay > r * r) continue
    out.card = card
    out.side = side === 1 ? 'front' : 'back'
    out.u = 0.5 + (side === 1 ? px : -px) / (2 * hw)
    out.v = 0.5 - py / (2 * hh)
    out.distance = distance
  }
  return out.card !== undefined
}
