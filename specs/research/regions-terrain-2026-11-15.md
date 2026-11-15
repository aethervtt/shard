# Regions at 20 × 16 km: what the terrain, anchors, precision and nav cost

Measured 2026-11-15 for Risen's regions (its ADR 0009 and the Shard section of its spec 0009),
with specs 0119–0123 built. Apple M5 Max, 18 cores, 36 GB, Node, nothing else running; not a named
machine (0075), so none of these are budgets yet. The script is
`apps/cli/src/regions.measure.test.ts` (skipped unless `SHARD_MEASURE=regions`; it writes JSON to
`SHARD_MEASURE_OUT`).

The terrain is 20 480 × 16 384 m at 1 m: 81 920 leaves of 64 m, depth 6, 20 roots of 4 096 m. Its
heights come from 0119's test generator (`terrain/src/heightfield/fixtures/ground.ts`: five octaves
of value noise and a graded pad, 43 ns a sample on one thread) with a little noise on top, and three
weighted material layers. Risen's `groundAt` will cost more per sample; every number below that's a
bake scales with it.

## Found and fixed: NavAgents in a `Grid` only moved in the floating origin's cell

The agent system (`nav/src/agents.ts`) read `Transform.translation` as the agent's position to find
its navmesh and steer it, and wrote the crowd's position back into it. Under a `Grid`, `translation`
is local to the agent's 2 km cell (cells are centred: cell 0 spans ±1 000 m). With a player at
(1 024, 1 024) and 12 agents on a 160 m ring around them, the 4 agents in the player's cell walked
to the player and the 8 across the line at 1 000 m stayed `idle` for 80 s, though `findPath` found a
complete path for every one of them. With the ring inside one cell, all 12 arrived.

Fixed in the same change: positions go through the agent's parent frame (`parentFrame64` in
transform, from the grid frames the last propagation solved). Now all 12 arrive in both layouts;
`terrain/src/heightfield/nav.test.ts` has agents on both sides of a cell line (it fails without the
fix), and nav's tests and benchmarks pass.

## 1. The bake at 20 480 × 16 384 m

| | |
| --- | --- |
| One leaf on one thread (`bakeNearPage`) | 0.83 ms |
| One parent (131² samples) on one thread | 1.81 ms |
| **Near (0119):** from nothing to streaming | 342 ms: the 100 resident pages (depths 0 and 1) on 17 workers |
| First collider tile under a dropped character | the third frame, 31 ms (its 13–14 tiles baked inline, as 0071 does for a tile due before its page lands) |
| Walking 60 s at 6 m/s | 63 leaves baked; no tile baked inline after the drop |
| Pool time per leaf / per parent | 3.3 ms / 25 ms (17 cold workers each preparing the generator and the noise kernel; the resident parents go first) |
| Pages held after the walk | 163 (6.4 MB of heights, normals, control and texels) |
| **Ahead (0071), for comparison** | 320 blocks in 11.0 s on 17 threads (522 ms a block on a thread), 647 MB of packs, peak RSS +4.4 GB |

- Near is what a client and the server should use: nothing stored, a third of a second to the first
  frame, and a few milliseconds of pool time per 64 m of new ground.
- The ahead bake's peak memory is the bake keeping every new page until the levels above the
  blocks are built. Fine for an offline bake; not something to run in a game.
- Process RSS grew 704 MB over the near run; the pages are 6.4 MB of it. The rest is 17 worker
  threads each loading the project bundle, Rapier and the noise kernel; I didn't separate them.

## 2. Survivors kilometres apart as anchors

8 characters on a 4 × 2 grid 4 km apart, each walking its own way at 6 m/s for 30 s (1 800 frames,
physics on, no GPU), against 1:

| | 1 survivor | 8 survivors |
| --- | --- | --- |
| `terrain/heightfields`, mean / worst frame | 0.02 / 0.56 ms | 0.07 / 5.81 ms |
| Whole headless frame, mean / worst | 0.11 / 0.88 ms | 0.45 / 6.29 ms |
| Collider tiles | 14 | 102 (about 13 each) |
| Leaves baked | 45 | 367 |
| Pages held | 145 | 467 |
| Tiles baked inline | 13 | 96, all on the first frames (8 characters dropped on unbaked ground) |

- The mean cost per anchor is small. The 5.8 ms worst frame isn't attributed yet: likely several
  anchors' new tiles becoming Rapier heightfields and nav sources in the same frame.
- 467 pages is close to the CPU page cache's 512 (plus the pinned coarse levels). Past about 10
  spread-out anchors, pages near one anchor start evicting another's, and they bake again. The cache
  size is `PageStore.capacity`, with no setting yet; a `TerrainBudget` field for it is the
  follow-up if Risen's servers hold more players than that.

## 3. f32 precision 10 km from the origin

f32 positions are 0.98 mm apart between 8 and 16 km, 1.95 mm out to 32 km.

| Character on the same ground | Above the ground, standing | Jitter standing | End of a 10 s walk vs at the origin |
| --- | --- | --- | --- |
| At the origin | 0.91217 m | 0 | — |
| 10 km out, no floating origin | 0.91217 m | 0 | 9 mm apart |
| 10 km out, floating origin on it | 0.91217 m | 0 | identical |
| 22.7 km out, no floating origin | never simulated | — | — |

- At 10 km Rapier's f32 changes the trajectory by millimetres, not its stability.
- **Past 20 km bodies don't simulate:** `PhysicsRange.radius` (20 km) parks bodies farther than that
  from the origin, by design. A region is 26 km corner to corner, so with the origin fixed at a
  corner the far side is parked, and with a floating origin following one survivor on the server,
  any survivor more than 20 km from it is. Put the origin at the map's centre (at most 13 km to any
  point) or raise `PhysicsRange.radius`.
- **Rendering doesn't need new work.** The same frame at 10 km with a floating origin on the camera
  is pixel-identical to the frame at the origin (0071's precision test holds it at 30 km). Without
  a floating origin the still frame differed by at most 1/255 in one channel; motion jitter wasn't
  measured. Shard already renders relative to the floating origin when the camera has
  `FloatingOrigin` and content sits in `Grid` cells (0040), so Risen should keep its entities in
  grid cells and put `FloatingOrigin` on each client's camera.

## 4. Colliders and nav for agents 160 m from a player

- **Colliders reach them.** Every `NavAgent`, character, dynamic body and `TerrainAnchor` is an
  anchor with `colliderRadius` (96 m), so an agent 160 m out has its own tiles. A player and 12
  agents on a 160 m ring held 64 tiles; the player's tiles and an agent's overlap (96 + 96 > 160), so
  the ground between them is solid. Past about 192 m, open ground between two anchors can have a
  gap no tile covers, unless something else anchors it.
- **Navmesh reaches them:** tiles bake from those collider tiles (the 240 frames that baked a
  520 m square took 1.1 s), every agent's `findPath` to the player was complete, and none fell through.
- **Agents walk to the player**: all 12 arrived within 80 s, across a grid cell line and inside one
  cell, after the fix at the top of this note.

## For Risen

- Use `"bake": "near"` with the region generator; nothing ships but the region file.
- Keep `groundAt` cheap: a leaf is 4 489 heights and 1 089 weight samples, so 1 µs a sample is
  about 5 ms a leaf on one thread.
- Holes (0120), scatter fields (0121), swept roads (0122) and rivers (0123) take the same plan, so
  the pad, the basement, the trees and the road agree by construction.
- Keep the origin within 20 km of every body (section 3).
