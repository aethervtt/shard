# 0114 — Breaching: agents that plan through shut doors, windows and walls

- **Status:** implemented
- **Packages:** `@aethervtt/shard-nav`, `@aethervtt/shard-structure`
- **Depends on:** 0037, 0112

## Context

In 0112 a zombie's filter excludes shut gates (`{ exclude: ['closed', 'locked'] }`). So a zombie
chasing a survivor behind a shut door gets a `partial` path that ends at whatever point outside is
closest. Nothing tells it which door is in the way, and `NavGateAhead` fires only for gates its
filter passes. In Project Zomboid, which the game recreates, zombies that hear or see you inside
walk to the door or window between you and bash it until it breaks. Later they also bash
barricades and the walls players build.

Detour prices a polygon only by its area. Flags can only include or exclude it. So a filter can't
price "this door while it's shut" through flags alone. But Detour can rewrite a polygon's area at
runtime (`setPolyArea` in recast-navigation 0.43.1), as cheaply as 0112 rewrites its flags.

## Goals

- Filters that **breach** gate states: they plan through a shut gate at a cost, and never walk
  through it while it's shut.
- `NavGateBlocked` when an agent reaches a gate it has to breach. The agent waits there, and
  carries on without a replan once the gate passes its filter.
- Windows and game-marked walls (player walls, barricades) as breachable gates.
- Many agents at one gate queue or spread along it in slots instead of piling into one point.

## Non-goals

- Damage, health and breaking. Game code decides what a waiting agent does and changes the gate.
- Grids (0037 grids have no gates) and framed navmeshes (0043), which `NavGateAhead` skips too.
- Turning agents. Nav reports which way to face (see Decisions).
- Hearing, sight and choosing targets: game code sets `NavAgent.target`.

## Design

### Shut areas and breaching filters

A gate's polygons keep their flags as in 0112 (`areaFlags(area) | state`). They also take a **shut
area** while they have any state bit set: area `a` becomes `a + 31`. Gates take areas 1–31 (0112
allowed 1–62), and areas 32–62 are reserved for shut gates. `mapGates` and `setGateFlags` call
`setPolyArea` along with `setPolyFlags`. A re-index finds a gate's polygons by either area. Tile
bytes, keys and the cache don't change, since the swap happens on landed tiles only.

```ts
interface NavFilterValue {                       // 0112's, plus:
  areas?: Record<number, number>
  exclude?: GateState[]
  breach?: GateState[]                           // planned through at a cost, never walked through
  breachCost?: number | Record<number, number>   // metres of walking per crossing, by gate area (20)
}
```

A filter with `breach` gets two Detour filters:

- **Plan**, a query filter only. It excludes `exclude`, and prices shut area `a + 31` at
  `cost(a) + breachCost(a) / depth(a)`. `findPath`, `nav.path` and agent plans use it.
- **Walk**, its crowd slot. It excludes `exclude ∪ breach`, so Detour's corridor never enters a
  shut gate. Shut areas cost what their open areas cost.

A gate's `depth` is its footprint's extent along the way agents cross it: `NavGateSpec.axis`
(structure passes its wall's normal, since a door is wider than its gate is deep), else across the
footprint's least width. A link gate's is its length. Each area uses the largest depth among its
gates, so the cost is exact when an area's gates are all as deep. Structure's doors are
`thickness + 2·gateMargin` deep (1.4 m on 0.2 m walls), and its windows `thickness + 2·windowReach`
(1.2 m). Filters without `breach` price shut areas like open ones, so survivors cost what they did
in 0112. A filter with a state in both `exclude` and `breach` (or a negative cost) warns
`nav/invalid-filter` and is left out; agents naming it path with the default.

The planner compares costs in Detour's metric: a polygon costs the distance from the middle of the
edge a path enters it by to the middle of the edge it leaves by. Round a house on open ground that
is longer than the walked path (1.8× on the breach house), so detours look dearer to the planner
than to a person measuring them (see Open questions).

**`GATE_SOLID`** is a nav-side state bit (bit 16, never written to Detour). A solid gate's polygons
get flags 0, so no filter passes them, breaching or not. Structure's open hatches use it instead
of `locked`. Otherwise a filter that breaches `locked` would plan into the hole, and 0112's default
filter, which excludes nothing, already passed open hatches.

### Legs: walking to the gate

`plan()` records the gates the path crosses in path order (0112's `pathGates`). It also records,
for each gate, where the path enters it and from which side. A breaching agent's path asks Detour
for a corner wherever the area changes, with the polygon each corner enters
(`FindPathOptions.refs`), so where it enters a gate is a corner. For a link gate, that's the link
end on the agent's side. The agent walks in **legs**. A leg ends at
the first gate ahead whose current flags hold one of its filter's `breach` states, or at the path's
end. `requestCrowd` asks the crowd to go to the leg's end rather than the path's.

The walk filter's cheapest route to a point in front of the gate is the plan's prefix, because a
prefix of an optimal path is optimal and the two filters cost the same outside shut gates. So the
crowd walks the plan.

### Slots

Each gate side has a **slot set**, built the first time an agent claims a slot there:

- Rows run parallel to the gate's face, `2.1·r` apart (r: the largest radius of the agents
  claiming there) and staggered.
- Row 0 sits just outside the gate's polygons and spans the gate's width plus `NavBreach.spread`
  on each side. Each row behind it is one slot wider at each end.
- A candidate counts if it's within half a radius of a polygon the walk filter passes (it snaps
  there), a full spacing from every other slot, and a navmesh raycast from 0.5 m in front of the
  gate reaches it with the walk filter. That keeps slots on the agent's side, off walls, and in the
  open. All `NavBreach.rows` rows are built at once.

Detour's crowd can't walk an agent through agents standing still, so no claim may send one through
the queue. An agent on a leg that ends at a shut gate walks to where its path enters it. It claims:

- **at the front,** within two slot spacings of the entry: the free slot in the lowest row, nearest
  first;
- **where the crowd stops it** (no 5 cm closer in 0.5 s) within `claim` of the gate or of its queue:
  the free slot nearest it.

So the first to arrive take the front, and the rest settle behind where they stop. An agent stopped
short of its slot waits there: it keeps its slot within a spacing of it, else takes the free slot
nearest it within that, else gives its slot up and waits in line without one. A waiting agent with
a slot moves up into a free slot next to it in a row ahead. An agent that finds no free slot waits
where it stands and takes the next slot that frees.

A slot frees when its agent leaves: it is despawned, stopped, retargeted or replanned elsewhere. The
nearest agent from a row behind then takes it, and the vacancy works its way back. A larger agent
claiming rebuilds the set and its claims. Slot sets are per-navmesh TypedArrays, dropped when the
gate's tiles or geometry change. Nothing per frame allocates.

### Arrival and `NavGateBlocked`

```ts
NavGateBlocked { entity, gate, flags, row, point }   // point: the gate point to face (world)
NavAgentState  { …, status: …|'blocked', gate: entity, row: u8 }   // 'blocked' appended to the enum
```

When an agent stands within `stoppingDistance` of its slot (or the crowd stops it, as above), nav
halts it the way it halts an arrival. The agent's status becomes `blocked`, `NavAgentState.gate` and
`row` are set, and `NavGateBlocked` fires. An agent waiting without a slot gets it too, with row 255
(`NO_ROW`). A queued agent gets a new event each time it reaches a new slot. A crowd agent moving
the transform gives way where the crowd pushes it while it waits, so a queue packs without overlap. `point` is the point on the gate's centre plane, within the gap, nearest the agent, so
game code can turn the agent toward it. `NavGateAhead` stays as it is, for gates the walk filter
passes.

### Movers: every agent breaches, whatever moves it

Claims, vacancies, arrival at a slot, the `blocked` status and `NavGateBlocked` run in
`nav/agents` from the `AgentRecord` and the agent's Transform, before and apart from the crowd
step. So they don't depend on what moves the agent. In 0115, an agent's tier comes from its
distance to the nearest player. A horde at a door 40 m from every player is never in the crowd,
and it still has to queue and fire `NavGateBlocked`, or the game never starts bashing.

`setNavMover(world, entity, 'external')` hands an agent to another mover (0115's tiers call it;
`'crowd'` hands it back). Nav then takes it out of the crowd and writes none of its drives, but
still plans it, computes its legs, claims its slot and fires its events. Each frame, an external
mover must:

- **Walk the leg:** the plan's corners up to `rec.legCount`, then `rec.legEnd`. That's the
  agent's slot once it has claimed one, else the leg's end (the gate's entry portal, or the
  path's end). Both stay on the agent's side of every shut gate.
- **Report arrival by writing the agent's Transform.** Nav reads its position next frame: within
  `claim` of the gate or its queue it claims a slot (lowest row first: nothing physical stops an
  external agent, so it never settles short), which changes `legEnd`, and within 5 cm of the slot
  it is `blocked` (nothing keeps external agents apart). A mover that can't get that close (a
  coarse one that snaps to cells) calls `navAgentAt(world, entity)` to say the agent stands at
  `legEnd`.
- **Stop while `blocked`,** and walk on when the status goes back to `moving` with a new
  `legEnd` (the gate passed its filter).

`NavAgentState.status`, `gate`, `row`, `remaining` and `corners` are written for external
agents too. `velocity` is the mover's to write.

### Gate changes

0112 marks an agent when a gate on its path changes bits its filter cares about. For an agent with
a breaching filter, a change to a gate on its path does one of three things:

| New flags, for this filter | Agent |
|---|---|
| hold an `exclude` state, or `GATE_SOLID` (or the gate is gone) | replans (0112's budget) |
| gained a `breach` state where it had none (an open door shut) | replans: a cheaper way may exist |
| hold no `breach` state (opened, broken, unbarricaded) | **continues**: frees its slot, next leg, no plan |
| one breach state to another (closed → locked) | nothing |

Continuing is one `requestMoveTarget` per agent. It doesn't call `findPath` or count in
`NavBudget.replans` or `nav.describe`'s replans. A queue walks on one at a time, nearest the gate's
middle first, each once the one ahead has gone two slot spacings (or after 2 s): 30 agents pushing
into a doorway at once jam for good. One walking on out of a queue shoves for 3 s (crowd avoidance
off): Detour's avoidance finds no way between agents standing that close, and its collisions push
them aside. An agent that hasn't reached the gate yet picks up
the change when it computes its next leg. Gates off an agent's path don't touch it (0112's
membership rule), so a zombie bashing the front door doesn't notice the back door opening. Game
code can retarget it.

### Structure: windows, broken doors, barricades, breachable walls

- **Doors.** A door breaks when game code sets `movement: 'none'` or `state: 'open'` (0112's
  channel: no collider, flags 0). Despawning an Opening fills its hole, so a door is never "broken"
  by despawning it.
- **Windows** are link gates already (`locked` until `movement: 'none'`). A filter that breaches
  `locked` plans through them by their link. Game code makes a broken window climbable with
  `movement: 'none'`. It keeps one unclimbable by leaving `movement: 'normal'` or barricading it.
- **Barricades on openings.** A new field `Opening.barricaded: bool` adds `custom` to the gate's
  flags and enables the opening's collider whatever its state or movement. Survivors exclude
  `custom`. Zombies breach it.
- **Breachable walls.** A new component:

  ```ts
  Breach { wall: entity, offset: f32, width: f32 }   // wall empty: this entity's own Wall;
                                                     // width 0: to the wall's end
  ```

  The span `[offset, offset + width]` is cut out of the wall's **nav shape** only; render and
  colliders are untouched, so the wall still draws and stops bodies. A Breach on its own entity logs
  as edit part `breach`, which colliders skip; one on the wall's own entity logs as that wall's
  edit, since the log has one part per entity. In its place is an area gate
  shaped like a door's: the span, `gateMargin` past each face, area `StructureSettings.nav.breachArea`
  (default 8), and flags `closed | locked`, so survivors never path through it. A span that
  overlaps an opening is clamped to the opening's edge, with a warning
  (`structure/breach-overlaps-opening`). Generated walls carry no `Breach`, so they stay
  unbreachable. Breaking a wall is a geometry edit by game code (despawn or split it). Its tiles
  rebuild, and agents crossing them replan by membership (0112).

### Changes to the crowd and agents (for merging with 0115)

0115 (hordes) changes far agents' movement, so these are all the changes 0114 makes there:

- `navmesh.ts`: `configureFilter` and `applyFilters` give a breaching filter its walk variant in its
  crowd slot and its plan variant as a query filter. `mapGates` and `setGateFlags` also swap areas.
- `agents.ts`:
  - `plan()` records each crossed gate's entry and side, and the current leg.
  - `stepAgent` runs the breach step (claims, arrival at the slot, `blocked`, the event) from the
    Transform for every navmesh agent, before the crowd, and skips the crowd for external agents.
  - `requestCrowd` targets `rec.legEnd` instead of the path's end. It places a new crowd agent on
    the surface, and gives physics-driven agents' positions to the crowd across only (x, z).
  - `crowdParams` turns avoidance off while an agent shoves out of a queue.
  - `readCrowd` leaves a `blocked` agent standing (moving the transform, it gives way to pushes),
    and doesn't report it `arrived`.
  - `markReplans` applies the table above.
- `state.ts`: `AgentRecord` gains `external`, `legCount`, `legEnd`, the leg, the slot and its
  progress, `shove`, and the path's gate entries.
- `breach.ts` (new): slot sets, claims, settling, release, `NavGateBlocked`, `setNavMover`,
  `navAgentAt`, `navAgentRecord`.
- Crowd parameters otherwise don't change: separation weight 0, query ranges as in 0037. 0115
  builds its tiers on `setNavMover` and the leg fields, and doesn't touch the breach step.

The surface placement fixes a 0037 bug breaching ran into. Detour places a crowd agent within 1.5
radii of the navmesh vertically, and a character's capsule centre sits higher above its feet than
that (0.92 m for a 0.3 m radius): such an agent never moved. 0037's ramp test passed because its
slab tops stood 0.5 m up.

### API sketch

```ts
import { findPath, GATE_SOLID, NavBreach, NavFilters, NavGateBlocked } from '@aethervtt/shard-nav'
import { Breach, Opening, Wall } from '@aethervtt/shard-structure'

world.insertResource(NavFilters, {
  survivor: { exclude: ['locked', 'custom'] },
  zombie: { breach: ['closed', 'locked', 'custom'], breachCost: { 10: 12, 11: 6, 8: 40 } },
})
world.insertResource(NavBreach, { claim: 4, spread: 0.5, rows: 8 })   // the defaults

const path = findPath(world, outside, inside, { filter: 'zombie' })
path.status   // 'complete'
path.breach   // the first gate it must breach, or -1

world.spawn([NavAgent, { target: survivor, filter: 'zombie', drive: 'character' }], Transform)
const blocked = world.reader(NavGateBlocked)
for (const { entity, gate, row, point } of blocked.read()) { /* attack the door when row is 0 */ }
world.set(door, Opening, { movement: 'none' })   // it broke: everyone waiting walks on, no replan

world.spawn([Wall, { a, b }], [Breach, {}])          // a player-built wall, all of it
world.spawn([Breach, { wall, offset: 2, width: 1.5 }]) // a span of another wall
world.set(window, Opening, { barricaded: true })      // + custom

// Nav's generic API: any game gate can be breached the same way.
nav.gates.set(owner, { points, yMin, yMax, area: 7, flags: GATE_CLOSED | GATE_LOCKED })
nav.gates.setFlags(owner, GATE_SOLID)
```

### Fixtures

`breachHouse(world, { backDoor, window, breach, at })` in `@aethervtt/shard-structure/fixtures`: a
10 × 6 m house, two rooms, 0.2 m walls. It has a 1 m front door in the south wall, and optionally
a back door in the north wall, a window (sill 0.9 m) in the east wall, and a 1.5 m `Breach` span in
the west wall, on a ground floor 20 m past it each side (or none, `ground: false`). The navmesh is
the town's (cell 0.1, radius 0.3), and the house returns its gates and points inside and outside.

### Agent surface

- `nav.path` returns `breach` (the gates to breach, in order). `nav.describe` adds:
  - filters' `breach` states and costs, and each shut area's depth (min and max);
  - for each agent, `blocked`, `gate` and `row`;
  - for each gate, its slot sets (sides, rows, claimed) and how many agents are waiting.
- The `navmesh` overlay draws slots (claimed and free), and blocked agents in amber.
  `structure.describe` counts breach gates and barricaded openings.
- `make-it-navigate.md` gains a section on breaching: a filter, `NavGateBlocked`, breaking the gate.
- Errors: `nav/invalid-filter`, `nav/invalid-gate` (area outside 1–31), `nav/reserved-area` (warn,
  once: a NavSource or link in 32–62 bakes as area 12), `structure/breach-overlaps-opening` (warn).

## Decisions

- **Shut gates switch to a twin area.** Detour prices only by area. `setPolyArea` is a write like
  `setPolyFlags`, with no tile build, key change or cache change.
- **Twins are `a + 31`, and gates take areas 1–31.** That's one twin per gate area within Detour's
  63, and nothing uses areas 32–62 today.
- **One twin per gate area, not per state.** Two states would halve the gate areas, and zombies
  price every shut state alike.
- **Breach cost in metres of walking, converted by gate depth.** It's the unit designers compare
  routes in, and Detour's cost is distance times area cost.
- **A plan filter and a walk filter per breaching name; only the walk one takes a crowd slot.**
  That keeps 15 named filters within Detour's 16 slots, and Detour can't enter a polygon its slot
  excludes, whatever the drive.
- **Legs, not truncated paths.** When a door opens, 30 waiting zombies need 30 move requests, not
  30 `findPath` calls through the replan budget.
- **Slots in rows, claimed near the gate.** Agents told to reach one point push forever under
  Detour's collision resolution, and claiming at plan time would let a far agent take the front
  row.
- **Nav reports where to face and doesn't turn agents.** 0037 never owned rotation; animation and
  controllers do.
- **`GATE_SOLID` for holes.** Breaching `locked` must never plan into an open hatch, and no state
  bit was left for it.
- **`Opening.barricaded` sets `custom`.** Structure owns its gates' flags, and survivors need to
  exclude barricades apart from locks.
- **A `Breach` component cuts nav only.** A standing wall still has to draw and stop bodies. Only
  the planner should see a way through it.
- **A broken wall is a geometry edit.** Breaking one changes render and colliders anyway, so its
  tile rebuild and the targeted replans come with that edit.
- **Breaching doesn't depend on the mover.** Claims, arrival and events run from the record and the
  Transform. A horde at a door far from every player is never in the crowd (0115), and it still
  has to start bashing.
- **Agents claim where they stop, not ahead.** Detour's crowd can't walk one through agents
  standing still: every scheme that assigned slots ahead gridlocked part of a 30-agent horde.
- **A queue walks on one at a time, shoving.** 30 agents released at once into a 1 m doorway jam
  for good (3 stayed out in 2 minutes), and with avoidance on, one can't get through those standing.
- **Fix 0037's placement of character agents here.** Breaching zombies are characters, and a
  character of a usual size never moved; the fix is two lines in `requestCrowd`, not crowd settings.
- **A door shutting on a breacher's path replans it; opening one doesn't.** A rise in cost may
  leave a cheaper route somewhere else, while a drop only shortens the plan it already has.

## Acceptance criteria

Headless (`structureModelPlugin`, `structurePhysicsPlugin`, `structureNavPlugin`, `physics3d`,
`nav`; no render plugin or GPU context), inline builds, `drive: 'transform'` unless stated. Zombie
filter: `{ breach: ['closed', 'locked'] }`. Survivor: `{ exclude: ['locked', 'custom'] }`. In
`structure/src/breach.test.ts`, and `nav/src/breach.test.ts` for nav's own gates.

- [x] **Front door.** A zombie outside a `breachHouse` whose front door is closed, targeting a
      survivor inside, with `transform` and `character` drives:
  - `findPath` with its filter is `complete`, with `breach` the door.
  - It stops in a row-0 slot, its centre within `gateMargin + 0.1 + stoppingDistance` of the door's
    face. `point` lies in the gap, and one `NavGateBlocked { gate: door, flags: GATE_CLOSED, row: 0 }`
    fires. Its status is `blocked` and `NavAgentState.gate` is the door.
  - Its centre never enters the gate's footprint over 600 steps.
  - Set to `movement: 'none'` (and, in a second run, `state: 'open'`), the door lets it through
    within 1 frame. Its replans and `nav.describe`'s stay at 0, and it reaches the survivor.
- [x] **Detour or bash.** D is the back-door route's cost minus the front-door route's, as the
      planner costs them (Detour's metric, above). With the front door closed and the back door
      open, a zombie with `breachCost` D + 4 m walks round and arrives with no `NavGateBlocked`.
      With D − 4 m it waits at the front door.
- [x] **Window.** A house with the front door locked (area 10 `breachCost` 200) and a closed window
      (area 11 `breachCost` 5): the plan crosses the window's link, and the zombie is blocked at the
      window (`flags: GATE_LOCKED`). Set to `movement: 'none'`, the window lets it cross the link
      with 0 replans and arrive. With `barricaded: true`, a filter that excludes `custom` goes for
      the door instead.
- [x] **Breachable wall.** With the front door's `breachCost` at 200 and a `Breach` span in the
      west wall:
  - the plan is complete through the span, and the zombie is blocked at it with
    `gate: <the Breach entity>` and `flags: GATE_CLOSED | GATE_LOCKED`, its centre outside the gate;
  - the wall's colliders match the run without a `Breach` (render compile doesn't read it);
  - splitting the wall around the span replans that zombie, and it arrives;
  - without the `Breach` (the door barricaded too), the zombie's path is partial, no
    `NavGateBlocked` fires, and a survivor's path from outside is partial.
- [x] **A horde at one door.** 30 zombies start on an arc 15 m from a closed door. Within 20 s
      (simulated), all 30 are `blocked`, in a slot or in line for one; no two centres are closer
      than `1.9·r`; row 0 holds as many agents as it has slots; every agent is within 6 m of the
      door. Once it opens, one walks on the next frame, all 30 are inside within 40 s, and none
      replans. Two inline runs give the same world hash.
- [x] **Without the crowd.** 30 zombies handed to an external mover (`setNavMover`), with no crowd
      slot, start 15 m from a closed door. A test mover walks each one along its leg to
      `rec.legEnd` at 3 m/s and moves nothing else. Within 20 s all 30 are `blocked` in distinct
      slots, no two closer than `1.9·r`, and each gets one `NavGateBlocked`; none has a crowd
      agent. Once the door opens, one walks on the next frame, and all arrive within 40 s with 0
      replans. Once 0115 lands, the test uses `NavTier` steer instead of the test mover.
- [x] **Targeted replans.** There are 30 zombies waiting at door A and 6 more with a filter that
      breaches only `closed` (and excludes `locked`), 20 zombies walking through open door B, and
      20 survivors elsewhere:
  - shutting B replans exactly the zombies whose paths cross it;
  - locking A replans exactly the 6, within ⌈6 / `NavBudget.replans`⌉ + 1 frames, and nobody else;
  - opening A: one walks on the next frame, most within 15 s, and none of the 30 replans;
  - none of it builds a tile.
- [x] **Holes.** With an open hatch, no filter (the default, the survivor, or one breaching
      `custom`) paths onto it; a solid gate (`GATE_SOLID`) has flags 0.
- [x] **0112 kept.** The tests of 0037 and 0112 pass. Tile keys and bytes are identical with and
      without breaching filters, through door toggles.
- [x] **Budgets.** On the town fixture (200 buildings under `pnpm bench`, 30 under `pnpm test`):
  - a breaching `findPath` from 40 m outside a house to its back room takes at most
    `nav/breach-path`;
  - building one door side's slot set takes at most `nav/gate-slots`;
  - the frame a door opens with 30 agents waiting at it takes at most `nav/breach-open`;
  - a frame of `nav/agents` while 30 zombies claim slots and settle takes at most
    `nav/breach-agents` (p95), and the frames while they wait allocate nothing
    (`allocationChecks`);
  - with 300 agents, 150 of them zombies breaching 50 houses, `nav/agents` stays within
    `nav/town-agents` (p95).

## Implementation notes

Measured on an Apple M5 Max (not a named machine), 2026-11-13, under `pnpm bench`'s settings
against the laptop's numbers: `nav/breach-path` 0.044 ms, `nav/gate-slots` 0.18 ms,
`nav/breach-open` 0.33 ms, `nav/breach-agents` 0.14 ms (p95), 0 collections while 30 wait, and
`nav/town-agents` 1.0 ms (p95) with 150 zombies breaching 50 houses. `nav/breach-open` was first
proposed as 0.1 ms for the flags and marking alone; the frame it counts includes the crowd's step.

- **Found, not fixed (0112):** a 1 m door whose gap sits on a tile corner (both of its axes on the
  6.4 m grid, such as x ∈ [31.5, 32.5] at z = 0) doesn't pass at 0.1 m cells, on `main` as here.
  0112's measurement ("every 1 m door passes at any alignment") didn't cover corners. The replans
  test puts its second house off the corners.
- Statuses: `blocked` is appended to `AGENT_STATUSES`, so saved enum values don't move.
- `nav/gate` (0112): a toggle now also writes each polygon's shut area. Its test timed one toggle,
  whose first-call cost alone went over the budget on `main` here (0.05 to 0.09 ms against 0.05);
  it now takes the median of 21, as the budget says: 0.005 ms.

## Open questions

- **Per-state breach costs** (a locked door costing more than a closed one). Proposed: later. It
  needs a twin per state, which halves the gate areas.
- **Giving up.** Should nav drop a wait after a time limit? Proposed: no. Game code sets `stopped`
  or a new target when `NavGateBlocked` has gone unanswered long enough.
- **Mixed gate depths in one area.** The cost uses the area's largest depth, so a shallower gate
  costs proportionally less. Proposed: accept it; `nav.describe` shows each area's depth spread.
- **The planner's metric.** Detour's A* costs edge midpoints, which round open ground overstates a
  detour (1.8× round the breach house), so zombies bash sooner than a breach cost in walked metres
  suggests. Detour's any-angle search (`DT_FINDPATH_ANY_ANGLE`) would bring it close to the walked
  length, but it needs the sliced find-path calls, which recast-navigation 0.43.1 doesn't bind.
  Proposed: live with it, and tune costs in play; bind them if a game needs the precision.
- **Doors on tile corners (0112).** Above. Proposed: a follow-up to 0112: measure every alignment
  including corners, and widen the gate's marking or shift tiles if needed.
