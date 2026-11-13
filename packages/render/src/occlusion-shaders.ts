/** WGSL of occlusion culling (0116): the module `shard::cull` imports under OCCLUSION. */
export const OCCLUSION_SHADERS: Record<string, string> = {
  'shard::cull_occlusion': `
// Occlusion culling (0116), linked into shard::cull by its OCCLUSION define: the cameras' buffers
// (uploaded by occlusionPlugin) and the tests the cull runs against them.
/** A camera's occlusion buffer (0116): world to view, projection scales, near, orthographic. */
struct OcclusionView {
  view: mat4x4f,
  proj: vec4f,
  /** Width, height, levels. */
  size: vec4u,
}

@group(0) @binding(9) var<uniform> occlusion_views: array<OcclusionView, 4>;
@group(0) @binding(10) var occlusion_depth: texture_2d_array<f32>;

/** Whether camera k's occlusion buffer hides a world sphere (OcclusionBuffer.hides). */
fn hides(k: u32, c: vec3f, r: f32) -> bool {
  let o = occlusion_views[k];
  let v = o.view * vec4f(c, 1.0);
  let d = -v.z;
  let nearest = d - r;
  if (nearest <= o.proj.z) { return false; }
  var x0: f32;
  var x1: f32;
  var y0: f32;
  var y1: f32;
  if (o.proj.w != 0.0) {
    x0 = (v.x - r) * o.proj.x;
    x1 = (v.x + r) * o.proj.x;
    y0 = (v.y - r) * o.proj.y;
    y1 = (v.y + r) * o.proj.y;
  } else {
    let far = d + r;
    let lx = v.x - r;
    let hx = v.x + r;
    let ly = v.y - r;
    let hy = v.y + r;
    x0 = min(lx / nearest, lx / far) * o.proj.x;
    x1 = max(hx / nearest, hx / far) * o.proj.x;
    y0 = min(ly / nearest, ly / far) * o.proj.y;
    y1 = max(hy / nearest, hy / far) * o.proj.y;
  }
  return hides_rect(k, x0, x1, y0, y1, nearest);
}

/** Whether NDC bounds at view depth nearest and beyond are hidden (OcclusionBuffer.hidesRect). */
fn hides_rect(k: u32, x0: f32, x1: f32, y0: f32, y1: f32, nearest: f32) -> bool {
  let o = occlusion_views[k];
  let W = i32(o.size.x);
  let H = i32(o.size.y);
  let px0 = i32(floor((x0 * 0.5 + 0.5) * f32(W)));
  let px1 = i32(floor((x1 * 0.5 + 0.5) * f32(W)));
  let py0 = i32(floor((0.5 - y1 * 0.5) * f32(H)));
  let py1 = i32(floor((0.5 - y0 * 0.5) * f32(H)));
  if (px1 < 0 || px0 >= W || py1 < 0 || py0 >= H) { return false; }
  let ax = max(px0, 0);
  let bx = min(px1, W - 1);
  let ay = max(py0, 0);
  let by = min(py1, H - 1);
  var l = 0u;
  loop {
    if (l + 1u >= o.size.z) { break; }
    if ((bx >> l) - (ax >> l) > 3 || (by >> l) - (ay >> l) > 3) { l++; } else { break; }
  }
  // From there, descend only into texels that don't hide it whole.
  var stack: array<u32, 128>;
  var top = 0u;
  let w = max(W >> l, 1);
  let h = max(H >> l, 1);
  for (var y = min(ay >> l, h - 1); y <= min(by >> l, h - 1); y++) {
    for (var x = min(ax >> l, w - 1); x <= min(bx >> l, w - 1); x++) {
      stack[top] = u32(x) | (u32(y) << 12u) | (l << 24u);
      top++;
    }
  }
  loop {
    if (top == 0u) { break; }
    top--;
    let e = stack[top];
    let x = i32(e & 0xfffu);
    let y = i32((e >> 12u) & 0xfffu);
    let kl = e >> 24u;
    if (textureLoad(occlusion_depth, vec2i(x, y), i32(k), i32(kl)).r < nearest) { continue; }
    if (kl == 0u) { return false; }
    let c = kl - 1u;
    let wk = max(W >> kl, 1);
    let hk = max(H >> kl, 1);
    let wc = max(W >> c, 1);
    let hc = max(H >> c, 1);
    let cx0 = max(x * 2, ax >> c);
    let cx1 = min(select(x * 2 + 1, wc - 1, x == wk - 1), min(bx >> c, wc - 1));
    let cy0 = max(y * 2, ay >> c);
    let cy1 = min(select(y * 2 + 1, hc - 1, y == hk - 1), min(by >> c, hc - 1));
    for (var yy = cy0; yy <= cy1; yy++) {
      for (var xx = cx0; xx <= cx1; xx++) {
        if (top == 128u) { return false; }
        stack[top] = u32(xx) | (u32(yy) << 12u) | (c << 24u);
        top++;
      }
    }
  }
  return true;
}

/** Whether camera k's occlusion buffer hides a world box (OcclusionBuffer.hidesBox). */
fn hides_box(k: u32, lo: vec3f, hi: vec3f) -> bool {
  let o = occlusion_views[k];
  var x0 = 1e30;
  var x1 = -1e30;
  var y0 = 1e30;
  var y1 = -1e30;
  var nearest = 1e30;
  for (var c = 0u; c < 8u; c++) {
    let p = vec3f(select(lo.x, hi.x, (c & 1u) != 0u), select(lo.y, hi.y, (c & 2u) != 0u), select(lo.z, hi.z, (c & 4u) != 0u));
    let v = o.view * vec4f(p, 1.0);
    let d = -v.z;
    if (d <= o.proj.z) { return false; }
    let n = select(v.xy / d, v.xy, o.proj.w != 0.0) * o.proj.xy;
    x0 = min(x0, n.x);
    x1 = max(x1, n.x);
    y0 = min(y0, n.y);
    y1 = max(y1, n.y);
    nearest = min(nearest, d);
  }
  return hides_rect(k, x0, x1, y0, y1, nearest);
}

/** Whether camera k hides an instance's box: a local box (center, half extents) through its rows. */
fn hides_oriented(k: u32, row0: vec4f, row1: vec4f, row2: vec4f, center: vec3f, e: vec3f) -> bool {
  let o = occlusion_views[k];
  var x0 = 1e30;
  var x1 = -1e30;
  var y0 = 1e30;
  var y1 = -1e30;
  var nearest = 1e30;
  for (var c = 0u; c < 8u; c++) {
    let l = vec4f(center + select(-e, e, vec3<bool>((c & 1u) != 0u, (c & 2u) != 0u, (c & 4u) != 0u)), 1.0);
    let p = vec3f(dot(row0, l), dot(row1, l), dot(row2, l));
    let v = o.view * vec4f(p, 1.0);
    let d = -v.z;
    if (d <= o.proj.z) { return false; }
    let n = select(v.xy / d, v.xy, o.proj.w != 0.0) * o.proj.xy;
    x0 = min(x0, n.x);
    x1 = max(x1, n.x);
    y0 = min(y0, n.y);
    y1 = max(y1, n.y);
    nearest = min(nearest, d);
  }
  return hides_rect(k, x0, x1, y0, y1, nearest);
}

/** Where a caster's shadow can fall, down to the view's floor (receiverBox): its box swept. */
fn receiver_box(sweep: vec4f, floor: f32, margin: f32, lo: ptr<function, vec3f>, hi: ptr<function, vec3f>) {
  let f = sweep.xyz;
  var len = max(sweep.w - dot(f, (*lo + *hi) * 0.5), 0.0);
  if (f.y < -1e-4) {
    let down = ((*hi).y - floor) / -f.y;
    if (down < len) { len = max(down, 0.0); }
  }
  let d = f * len;
  *lo = *lo + min(d, vec3f(0.0)) - vec3f(margin);
  (*lo).y = max(floor, (*lo).y);
  *hi = *hi + max(d, vec3f(0.0)) + vec3f(margin);
}

/** An instance's world box: a local box (center, half extents) through its rows (orientedBox). */
fn oriented_box(row0: vec4f, row1: vec4f, row2: vec4f, center: vec3f, e: vec3f, lo: ptr<function, vec3f>, hi: ptr<function, vec3f>) {
  *lo = vec3f(1e30);
  *hi = vec3f(-1e30);
  for (var c = 0u; c < 8u; c++) {
    let l = vec4f(center + select(-e, e, vec3<bool>((c & 1u) != 0u, (c & 2u) != 0u, (c & 4u) != 0u)), 1.0);
    let p = vec3f(dot(row0, l), dot(row1, l), dot(row2, l));
    *lo = min(*lo, p);
    *hi = max(*hi, p);
  }
}`,
}
