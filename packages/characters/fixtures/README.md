# Character fixtures

Test data for `@aethervtt/shard-characters`. `src/fixture-assets.ts` copies it into a temporary
project; `src/fixture.test.ts` plays every clip on the body.

## risen/ — the body

`base.glb`, `base.glb.meta`, `body.json`: Risen's default MakeHuman human (MPFB 2.0.18, Blender
5.2), built by Risen's `tools/makehuman` pipeline (see its README). 1.66 m, Y-up, feet at y = 0,
facing +Z, A-pose, 53 joints with UE-mannequin names (`Root`, `pelvis`, `spine_01..03`, `neck_01`,
`head`, `clavicle/upperarm/lowerarm/hand_l/_r`, fingers, `thigh/calf/foot/ball_l/_r`).

Licence: CC0. The MakeHuman base mesh, targets, and rig weights are CC0, as is MPFB's system assets
pack (MPFB's own code is GPL-3.0-or-later; its output isn't).

## cmu/ — motion capture

Three clips from the CMU Graphics Lab Motion Capture Database, each a GLB with a bare skeleton
(27 joints, a `Skin` and no mesh) and one animation at 30 fps: metres, Y-up, facing +Z, in place.

| File         | Source take             | Window (120 fps frames) | Frames | Duration | Loops |
| ------------ | ----------------------- | ----------------------- | ------ | -------- | ----- |
| `walk.glb`   | 02_01 "walk"            | 102–234                 | 34     | 1.100 s  | yes   |
| `idle.glb`   | 113_21 "Standing Still" | 80–672                  | 149    | 4.933 s  | yes   |
| `attack.glb` | 02_05 "punch/strike"    | 778–942                 | 42     | 1.367 s  | no    |

The walk is one gait cycle (two steps). The idle is one slow side-to-side weight shift with the
arms down. The attack goes from a boxing guard into a straight right punch and back to guard.

Sources: Bruce Hahne's 2010 BVH conversion of the database (cgspeed.com), as mirrored at
<https://github.com/meshula/cmu-mocap>:

- <https://raw.githubusercontent.com/meshula/cmu-mocap/master/data/002/02_01.bvh>
  (sha256 `cf56db43157acc3d200b3d4215523f54d354a8926bea67e1f6c8031bd335ba7e`)
- <https://raw.githubusercontent.com/meshula/cmu-mocap/master/data/113/113_21.bvh>
  (sha256 `127c9364e77f6a8eb4197a4d58959f71758072a4db2f05e0360464aef16ce57a`)
- <https://raw.githubusercontent.com/meshula/cmu-mocap/master/data/002/02_05.bvh>
  (sha256 `19e935a336e06981c1680b79c7db7cd9b2c95ff404696f6742181b9e4da39057`)

Licence: free for any use. From mocap.cs.cmu.edu: "This data is free for use in research and
commercial projects worldwide." CMU asks that anything published with it carry this
acknowledgement: "The data used in this project was obtained from mocap.cs.cmu.edu. The database
was created with funding from NSF EIA-0196217." The BVH conversion adds no restrictions.

### Conversion

`cmu/bvh_to_glb.py`, headless in Blender 5.2:

```sh
blender -b --factory-startup -P bvh_to_glb.py -- 02_01.bvh walk.glb walk 102 234 1 travel
blender -b --factory-startup -P bvh_to_glb.py -- 113_21.bvh idle.glb idle 80 672 1 mean
blender -b --factory-startup -P bvh_to_glb.py -- 02_05.bvh attack.glb attack 778 942 0 reach
```

1. Import the BVH at 0.0254 / 0.45 m per unit (CMU's length unit is 1/0.45 inch).
2. Sample every joint's model-space transform at 30 fps over the window. Frame 1 of every file is
   the conversion's T-pose; motion frames come after it.
3. Turn about the vertical so the clip faces +Z: the walk's direction of travel, the idle's mean hips
   facing, or the hips' facing when the punching hand reaches furthest.
4. In place: take out the walk's straight-line travel over the cycle (the hips keep their sway and
   their up-and-down motion), then centre each clip on the mean midpoint of the ankles.
5. Rest pose: the file's T-pose, hips over the origin at the hips' height above the ankles plus the
   clip's median ankle height (so `rotation-and-root`'s hip ratio compares standing heights). The
   T-pose tips the head 10–15° forward, so the rest head is pitched until its bone points straight
   up; otherwise a level head retargets looking up.
6. Drop `LHipJoint` and `RHipJoint` (they never rotate) and fold `Neck` and `Neck1` into `Head`,
   which then carries the whole turn of the head from the chest.
7. Loops: spread the first-to-last mismatch of each joint over the clip, so the last frame equals
   the first. The windows were picked where it was smallest (under 1 cm of joint position).
8. Export a GLB with the skeleton and one action. The exporter writes the skin
   (inverse bind matrices from the rest pose), no mesh.

### Joint map

`cmu/cmu-risen.jointmap.json` maps the CMU names onto the body's: `Hips → pelvis`,
`LowerBack/Spine/Spine1 → spine_01/02/03`, `Head → head`, then shoulders, arms, hands, legs, feet,
and toes onto `clavicle`, `upperarm`, `lowerarm`, `hand`, `thigh`, `calf`, `foot`, and `ball`.
`neck_01` and the fingers stay at rest; `LeftFingerBase`, `LeftHandIndex1`, `LThumb` and their right
counterparts match nothing.
