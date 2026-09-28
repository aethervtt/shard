import { AssetStore, defineAssetType } from '@aethervtt/shard-assets'
import { defineResource } from '@aethervtt/shard-core'

// The skin asset stays in the core renderer so glTF models with skins import and load without
// skinningPlugin; the plugin is what deforms meshes by them (spec 0056).

/** Joints one skin can have: the vertex stage indexes joints with 16 bits, budgets assume 256. */
export const MAX_JOINTS = 256

export interface SkinAsset {
  name: string
  /** Joint entity paths, relative to the model root (e.g. "Armature/Hips/Spine"). */
  joints: string[]
  skeleton?: string
  /** Each joint's rest pose (local TRS), for retargeting. */
  restPose: { translation: number[]; rotation: number[]; scale: number[] }[]
  /** 16 floats per joint, column-major. */
  inverseBindMatrices: Float32Array
}

export const Skins = defineResource<AssetStore<SkinAsset, 'Skin'>>('render/Skins', {
  description: 'Skins (joint paths, inverse bind matrices, rest pose) by guid.',
  init: () => new AssetStore('Skin'),
})

interface SkinHeader extends Omit<SkinAsset, 'inverseBindMatrices'> {
  matrices: number
}

/** Skin artifacts: the header as JSON, the inverse bind matrices as bytes. */
export const SkinAssetType = defineAssetType<SkinAsset>('Skin', {
  store: Skins,
  load: (artifact) => {
    const header = artifact.json as unknown as SkinHeader
    const bytes = artifact.bytes!.slice()
    const { matrices, ...rest } = header
    return { ...rest, inverseBindMatrices: new Float32Array(bytes.buffer, 0, matrices * 16) }
  },
})

/** A skin's artifact JSON (with `bytes` holding the inverse bind matrices), for importers. */
export function skinArtifact(skin: Omit<SkinAsset, 'inverseBindMatrices'>): SkinHeader {
  return { ...skin, matrices: skin.joints.length }
}
