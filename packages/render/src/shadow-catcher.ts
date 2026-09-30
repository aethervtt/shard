// The shadow catcher (0052): a surface you can't see except for the shadows falling on it. Under a
// view that clears to alpha, those shadows land on the page (a dice tray's floor); over a scene,
// it darkens what's behind it.

import { t } from '@aethervtt/shard-core'
import { definePlugin } from '@aethervtt/shard-runtime'
import { defineMaterial } from './materials'
import { Shaders } from './plugin'
import { registerShaders } from './shaders'

export const SHADOW_CATCHER_SHADERS: Record<string, string> = {
  'shard::pbr::catcher': `
import shard::view::view;
import shard::pbr::types::VertexOutput;
import shard::pbr::lights::{ lights, clusters, directional, LIGHT_SPOT, NO_SHADOW, CLUSTER_COUNT, MAX_PER_CLUSTER };
import shard::pbr::shadows::{ directional_shadow, spot_shadow, point_shadow };
import shard::pbr::lighting::cluster_of;

const FLAG_RECEIVER: u32 = 4u;

fn brightest(c: vec3f) -> f32 { return max(c.r, max(c.g, c.b)); }

/**
 * How much of the shadow-casting light reaches the surface: the light of every shadow-casting
 * light with shadows, over that light without them. 1 when none cast shadows, or when the mesh
 * doesn't receive them. Shadow catchers (and the dice tray, 0054) turn 1 − this into alpha.
 */
fn shadow_visibility(in: VertexOutput) -> f32 {
  if ((in.flags & FLAG_RECEIVER) == 0u) { return 1.0; }
  let n = normalize(in.world_normal);
  let p = in.world_position;
  let view_depth = -(view.view * vec4f(p, 1.0)).z;
  var lit = 0.0;
  var total = 0.0;
  for (var i = 0u; i < directional.count; i++) {
    let light = directional.lights[i];
    if (light.shadowed == 0u) { continue; }
    let e = max(dot(n, normalize(light.direction)), 0.0) * brightest(light.color);
    total += e;
    lit += e * directional_shadow(p, n, view_depth, in.clip.xy);
  }
  let cluster = cluster_of(in.clip, view_depth);
  if (cluster >= 0) {
    let count = clusters[cluster];
    let base = CLUSTER_COUNT + u32(cluster) * MAX_PER_CLUSTER;
    for (var k = 0u; k < count; k++) {
      let light = lights[clusters[base + k]];
      if (light.shadow == NO_SHADOW) { continue; }
      let to_light = light.position - p;
      let d2 = max(dot(to_light, to_light), 1e-4);
      let d = sqrt(d2);
      let l = to_light / d;
      let ratio = d / light.range;
      let window = clamp(1.0 - ratio * ratio * ratio * ratio, 0.0, 1.0);
      var attenuation = window * window / d2;
      if (light.kind == LIGHT_SPOT) {
        let spot = clamp(dot(-l, light.direction) * light.spot_scale + light.spot_offset, 0.0, 1.0);
        attenuation *= spot * spot;
      }
      let e = max(dot(n, l), 0.0) * attenuation * brightest(light.color);
      if (e <= 0.0) { continue; }
      var shadow = 1.0;
      if (light.kind == LIGHT_SPOT) {
        shadow = spot_shadow(light.shadow, p, n, light.position, light.shadow_bias, light.shadow_normal_bias, light.shadow_softness, in.clip.xy);
      } else {
        shadow = point_shadow(light.shadow, p, n, light.shadow_bias, light.shadow_normal_bias, light.shadow_softness, in.clip.xy);
      }
      total += e;
      lit += e * shadow;
    }
  }
  return select(1.0, lit / total, total > 0.0);
}`,
  'shard::material::shadow_catcher': `
import shard::pbr::types::VertexOutput;
import shard::pbr::catcher::shadow_visibility;
import material::shadow_catcher::ShadowCatcher;

/** No color; alpha opacity × (1 − visibility) over every shadow-casting light. */
override fn shade(in: VertexOutput) -> vec4f {
  return vec4f(0.0, 0.0, 0.0, ShadowCatcher.opacity * (1.0 - shadow_visibility(in)));
}`,
}

/**
 * Invisible except for the shadows it receives (0052): color 0, alpha `opacity × (1 − visibility)`
 * over every shadow-casting light. Premultiplied, so it darkens what's behind it by that alpha.
 * Needs `shadowCatcherPlugin` (in `forwardPlugin`).
 */
export const ShadowCatcher = defineMaterial('render/ShadowCatcher', {
  extends: 'none',
  blend: 'premultiplied',
  fields: {
    opacity: t.f32({
      default: 0.6,
      min: 0,
      max: 1,
      description: 'Alpha of full shadow. Partial shadow (penumbra, one of two lights) is less.',
    }),
  },
  shader: 'shard::material::shadow_catcher',
  description:
    'Invisible except for the shadows it receives: under a camera clearing to alpha 0 they fall on the page (a dice tray floor). Give its mesh NotShadowCaster.',
})

/** The ShadowCatcher material's shader. */
export const shadowCatcherPlugin = definePlugin({
  name: 'render/shadow-catcher',
  dependencies: ['render/forward'],
  provides: [ShadowCatcher],
  build() {},
  ready(app) {
    registerShaders(app.world.resource(Shaders), SHADOW_CATCHER_SHADERS)
  },
})
