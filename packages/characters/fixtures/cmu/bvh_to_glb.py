# Blender 5.2 headless: one CMU BVH (cgspeed conversion) window -> a GLB with a bare skeleton and one
# animation, metres, Y-up, facing +Z, in place, rested in the file's frame-1 T-pose.
#
# blender -b --factory-startup -P bvh_to_glb.py -- in.bvh out.glb name start end loop heading
#   start/end: motion frame indices at 120 fps (0 = the first frame after the T-pose); end - start
#              must be a multiple of 4 (output is 30 fps).
#   loop:      1 = make the last frame equal the first (rotation/translation error spread linearly)
#   heading:   travel | mean | reach  (what turns to face +Z: the hips' travel, the mean hips facing,
#              or the hips facing at the right hand's furthest forward reach)
import math
import sys

import bpy
from mathutils import Matrix, Quaternion, Vector

S = 0.0254 / 0.45  # CMU length unit (1/0.45 inch) in metres
STEP = 4  # 120 fps -> 30 fps

argv = sys.argv[sys.argv.index('--') + 1 :]
src_path, out_path, name = argv[0], argv[1], argv[2]
a, b = int(argv[3]), int(argv[4])
loop = argv[5] == '1'
heading = argv[6]
assert (b - a) % STEP == 0, 'window must be a multiple of 4 frames'
K = (b - a) // STEP

for o in list(bpy.data.objects):
  bpy.data.objects.remove(o)
for act in list(bpy.data.actions):
  bpy.data.actions.remove(act)

bpy.ops.import_anim.bvh(
  filepath=src_path,
  global_scale=S,
  frame_start=1,
  use_fps_scale=False,
  update_scene_fps=False,
  update_scene_duration=True,
  rotate_mode='NATIVE',
  axis_forward='-Z',
  axis_up='Y',
)
src = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
scene = bpy.context.scene
order = []  # bones parents-first


def visit(bone):
  order.append(bone.name)
  for c in bone.children:
    visit(c)


for bone in src.data.bones:
  if bone.parent is None:
    visit(bone)
parent = {n: (src.data.bones[n].parent.name if src.data.bones[n].parent else None) for n in order}


def sample(frame):
  scene.frame_set(frame)
  return {n: src.pose.bones[n].matrix.copy() for n in order}


# Blender frame 1 is the T-pose; motion frame i is Blender frame i + 2.
tpose = sample(1)
poses = [sample(a + 2 + k * STEP) for k in range(K + 1)]
# Every frame of the window (120 fps) for statistics.
fine = [sample(f) for f in range(a + 2, b + 3)]

# Joints left out of the export: the hip joints never rotate (no degrees of freedom in CMU's ASF), and
# the neck (Neck, Neck1) folds into Head, which then carries the whole turn of the head from the chest.
DROP = {'LHipJoint', 'RHipJoint', 'Neck', 'Neck1'}


def kept_parent(n):
  p = parent[n]
  while p in DROP:
    p = parent[p]
  return p


order = [n for n in order if n not in DROP]
parent = {n: kept_parent(n) for n in order}


def yaw_of(m, rest):
  fwd = (m.to_3x3() @ rest.to_3x3().inverted()) @ Vector((0, -1, 0))
  return math.atan2(fwd.y, fwd.x)


rest_hips = tpose['Hips']
if heading == 'travel':
  d = poses[-1]['Hips'].translation - poses[0]['Hips'].translation
  phi = math.atan2(d.y, d.x)
elif heading == 'mean':
  sx = sum(math.cos(yaw_of(p['Hips'], rest_hips)) for p in fine)
  sy = sum(math.sin(yaw_of(p['Hips'], rest_hips)) for p in fine)
  phi = math.atan2(sy, sx)
else:
  best, phi = -1e9, 0.0
  for p in fine:
    y = yaw_of(p['Hips'], rest_hips)
    v = p['RightHand'].translation - p['Hips'].translation
    reach = v.x * math.cos(y) + v.y * math.sin(y)
    if reach > best:
      best, phi = reach, y
turn = Matrix.Rotation(-math.pi / 2 - phi, 4, 'Z')

# Ground-plane travel: a linear trend for loops (it walks), none otherwise; then centre the clip on the
# mean of the ankles' midpoint.
p0 = (turn @ poses[0]['Hips']).translation
pK = (turn @ poses[-1]['Hips']).translation
shifted = []
for k, p in enumerate(poses):
  trend = (pK - p0) * (k / K) if loop else Vector((0, 0, 0))
  m = Matrix.Translation(Vector((-trend.x, -trend.y, 0))) @ turn
  shifted.append({n: m @ p[n] for n in order})
cx = sum((p['LeftFoot'].translation.x + p['RightFoot'].translation.x) / 2 for p in shifted) / len(shifted)
cy = sum((p['LeftFoot'].translation.y + p['RightFoot'].translation.y) / 2 for p in shifted) / len(shifted)
centre = Matrix.Translation(Vector((-cx, -cy, 0)))
shifted = [{n: centre @ p[n] for n in order} for p in shifted]

# Rest: the T-pose, hips over the origin at standing height: hips above the ankles in the T-pose plus
# the ankles' height in the clip (median over frames of the lower ankle).
lows = sorted(min(p['LeftFoot'].translation.z, p['RightFoot'].translation.z) for p in fine)
ankle = lows[len(lows) // 2]
t_ank = (tpose['LeftFoot'].translation.z + tpose['RightFoot'].translation.z) / 2
H = tpose['Hips'].translation.z - t_ank + ankle
th = tpose['Hips'].translation
rest_shift = Matrix.Translation(Vector((-th.x, -th.y, H - th.z)))
rest = {n: rest_shift @ tpose[n] for n in order}
# The T-pose tips the head 10-15 degrees forward, so a head held straight would retarget looking up:
# the rest head is pitched (shortest arc) until its bone points straight up.
hm = rest['Head']
up = (hm.to_3x3() @ Vector((0, 1, 0))).normalized()
lift = up.rotation_difference(Vector((0, 0, 1))).to_matrix()
rest['Head'] = Matrix.Translation(hm.translation) @ (lift @ hm.to_3x3()).to_4x4()

# A fresh armature with that rest.
data = bpy.data.armatures.new(name)
arm = bpy.data.objects.new('Armature', data)
scene.collection.objects.link(arm)
bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode='EDIT')
for n in order:
  eb = data.edit_bones.new(n)
  eb.length = max(src.data.bones[n].length, 0.01)
for n in order:
  eb = data.edit_bones[n]
  if parent[n]:
    eb.parent = data.edit_bones[parent[n]]
  eb.use_connect = False
  eb.matrix = rest[n]
bpy.ops.object.mode_set(mode='OBJECT')
rest_local = {n: data.bones[n].matrix_local.copy() for n in order}

# Local (basis) transforms per frame.
basis = []
for p in shifted:
  row = {}
  for n in order:
    if parent[n]:
      pr = rest_local[parent[n]]
      m = (pr.inverted() @ rest_local[n]).inverted() @ p[parent[n]].inverted() @ p[n]
    else:
      m = rest_local[n].inverted() @ p[n]
    loc, rot, _ = m.decompose()
    row[n] = (loc, rot)
  basis.append(row)

if loop:
  for n in order:
    q0, qK = basis[0][n][1], basis[K][n][1]
    err = qK @ q0.inverted()  # q_K = err @ q_0
    l0, lK = basis[0][n][0], basis[K][n][0]
    for k in range(K + 1):
      u = k / K
      fix = Quaternion().slerp(err.inverted(), u)
      loc, rot = basis[k][n]
      basis[k][n] = (loc + (l0 - lK) * u, fix @ rot)
    basis[K][n] = basis[0][n]

arm.animation_data_create()
action = bpy.data.actions.new(name)
arm.animation_data.action = action
for n in order:
  pb = arm.pose.bones[n]
  pb.rotation_mode = 'QUATERNION'
prev = {}
for k, row in enumerate(basis):
  for n in order:
    pb = arm.pose.bones[n]
    loc, rot = row[n]
    if n in prev and prev[n].dot(rot) < 0:
      rot = -rot
    prev[n] = rot
    pb.rotation_quaternion = rot
    pb.keyframe_insert('rotation_quaternion', frame=k)
    if parent[n] is None:
      pb.location = loc
      pb.keyframe_insert('location', frame=k)
bpy.data.objects.remove(src)
for other in list(bpy.data.actions):
  if other != action:
    bpy.data.actions.remove(other)
scene.frame_start, scene.frame_end = 0, K
scene.render.fps, scene.render.fps_base = 30, 1
for o in bpy.data.objects:
  o.select_set(o == arm)
bpy.ops.export_scene.gltf(
  filepath=out_path,
  export_format='GLB',
  use_selection=True,
  export_yup=True,
  export_animations=True,
  export_animation_mode='ACTIONS',
  export_force_sampling=True,
  export_frame_range=True,
  export_optimize_animation_size=True,
  export_def_bones=False,
  export_skins=True,
  export_morph=False,
  export_materials='NONE',
)
print(f'CLIP {name} frames {K + 1} duration {K / 30:.4f}s fps 30 hips_rest {H:.4f} ankle {ankle:.4f} heading_deg {math.degrees(phi):.1f}')
