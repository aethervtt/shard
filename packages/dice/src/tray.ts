import { t } from '@aethervtt/shard-core'
import { defineMaterial } from '@aethervtt/shard-render'

// The tray floor (0054): a shadow catcher (0052) that also draws contact blobs. The floor and the
// blobs are instances of one quad with this one material, so they're one draw: an instance whose
// InstanceData.x is above 0 is a blob of that strength, the others catch shadows.

export const TRAY_SHADERS: Record<string, string> = {
  'dice::tray': `
import shard::pbr::types::VertexOutput;
import shard::mesh::vertex_instance_data;
import shard::pbr::catcher::shadow_visibility;
import material::dice_tray::DiceTray;

override fn vertex_extra(position: vec3f, normal: vec3f, uv: vec2f) -> vec4f {
  return vec4f(vertex_instance_data().x, 0.0, 0.0, 0.0);
}

override fn shade(in: VertexOutput) -> vec4f {
  let blob = in.extra.x;
  if (blob > 0.0) {
    // A soft round shadow under a die: dense in the middle, gone at the quad's rim.
    let r = length(in.uv * 2.0 - 1.0);
    let a = 1.0 - smoothstep(0.0, 1.0, r);
    return vec4f(0.0, 0.0, 0.0, a * a * blob * DiceTray.blobOpacity);
  }
  return vec4f(0.0, 0.0, 0.0, DiceTray.shadowOpacity * (1.0 - shadow_visibility(in)));
}`,
}

export const DiceTray = defineMaterial('dice/DiceTray', {
  extends: 'none',
  blend: 'premultiplied',
  fields: {
    shadowOpacity: t.f32({ default: 0.55, min: 0, max: 1, description: 'Alpha of full shadow.' }),
    blobOpacity: t.f32({
      default: 0.6,
      min: 0,
      max: 1,
      description: 'Alpha of a contact blob under a resting die.',
    }),
  },
  shader: 'dice::tray',
  description:
    'The dice tray: invisible but for the shadows it catches and the contact blobs under blended dice (and every die in the large-pool tier).',
})
