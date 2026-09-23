struct Uniforms {
  // Scale that fits the [-1, 1] world into the viewport without stretching.
  scale: vec2f,
  yaw: f32,
  pitch: f32,
  size: f32,
}

@group(0) @binding(0) var<uniform> u: Uniforms;
// ECS columns uploaded as-is: vec3 fields stored flat, stride 3.
@group(0) @binding(1) var<storage, read> positions: array<f32>;
@group(0) @binding(2) var<storage, read> velocities: array<f32>;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) color: vec3f,
  @location(1) corner: vec2f,
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VertexOut {
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  let corner = corners[vi];
  let base = ii * 3u;
  let p = vec3f(positions[base], positions[base + 1u], positions[base + 2u]);
  let v = vec3f(velocities[base], velocities[base + 1u], velocities[base + 2u]);

  // Spin around the disk axis, then tilt toward the camera.
  let cy = cos(u.yaw);
  let sy = sin(u.yaw);
  let spun = vec3f(p.x * cy - p.y * sy, p.x * sy + p.y * cy, p.z);
  let cp = cos(u.pitch);
  let sp = sin(u.pitch);
  let view = vec3f(spun.x, spun.y * cp - spun.z * sp, spun.y * sp + spun.z * cp);

  let perspective = 1.0 / (1.6 - view.z * 0.5);
  var out: VertexOut;
  out.position = vec4f((view.xy * perspective + corner * u.size) * u.scale, 0.0, 1.0);
  let speed = clamp(length(v) * 0.9, 0.0, 1.0);
  out.color = mix(vec3f(1.0, 0.45, 0.18), vec3f(0.35, 0.6, 1.0), speed);
  out.corner = corner;
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let falloff = max(0.0, 1.0 - dot(in.corner, in.corner));
  return vec4f(in.color * falloff * falloff * 0.28, 1.0);
}
