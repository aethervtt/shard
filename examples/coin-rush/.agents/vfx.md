# Trails, beams and projected decals

"render/forward" includes ribbonsPlugin and decalsPlugin. SDK hosts can use forwardCorePlugin
plus just the optional plugins they need. Components are schema-authored; use render.describe
for ribbons/decals records, points/triangles, age, allocation sizes and structured error codes.

Trail follows its Transform (including parent/bone attachments) and local offset. Old points
stay in world space. capacity bounds the history, lifetime expires points, minDistance rejects
duplicates, and breakDistance clears history after teleporting. playing=false drains the trail;
paused=true freezes its clock. Beam uses local start/end, or end relative to its target entity;
local points override endpoints. segments/noise/seed control deterministic endpoint-beam shape.
Both accept width, ordered widthCurve [{at,value}], color/endColor, opacity, repeat, scroll,
blend alpha/additive, layers and a Texture handle. Width curves use trail age or beam distance.
Colors are display-referred unlit overlays, not PBR lighting inputs. Alpha compositing uses
stable creation order; intersecting transparent ribbons are not sorted per segment.

Decal projects along local -Z, with local X/Y as UVs and size as the clipping box. Mark eligible
rigid Mesh3d entities with DecalReceiver; its mask must overlap receiverMask. The projector clips
real triangles and caches them until geometry/transforms/masks change. maxAngle rejects grazing
and back-facing surfaces; offset avoids z fighting. lifetime=0 persists; fadeOut fades the end
of a finite lifetime. paused freezes age, playing=false hides it. maxVertices and a 32768 input
triangle budget bound projection; overflow gives a diagnostic and no partial mark. Skinned,
morph/compute-deformed and transparent receivers are unsupported. No PBR normal/roughness decals.

All texture handles resolve through the host AssetServer catalog (GUIDs work). No file picker,
URL loading or database dependency is introduced. Prefabs carry reusable VFX component settings;
0081 visual tracks own activation and cleanup. A beam visual track's endpoint binds another
named sequence target. Use property tracks for opacity/width changes. Effects are presentation;
the host remains responsible for damage, collision and persistent game state.

Preview: playground/vfx.html. Toggle each feature to isolate its pixels; replay a seed, pause,
clear, and switch perspective/orthographic cameras. The host registers the original textures.
