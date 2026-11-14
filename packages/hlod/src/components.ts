import { defineComponent, defineResource, defineTag, t } from '@aethervtt/shard-core'

/** On each proxy's root (a child of the partition root): which cell it stands for. */
export const HlodProxy = defineComponent(
  'hlod/Proxy',
  {
    grid: t.u8({ readonly: true }),
    x: t.i32({ readonly: true }),
    z: t.i32({ readonly: true }),
    triangles: t.u32({ readonly: true, description: "Level 0's triangles." }),
    levels: t.u8({ readonly: true, description: 'Levels of detail it has.' }),
  },
  {
    description: "An HLOD proxy (0073): one cell's drawn meshes merged, with levels inside it.",
    serialize: false,
  },
)

/** A subtree that never goes into a proxy (interiors a far level keeps, if any). */
export const Exclude = defineTag('hlod/Exclude', {
  description: 'This entity and its subtree are never merged into an HLOD proxy (0073).',
})

export interface HlodSettingsValue {
  enabled: boolean
  /**
   * Part-size levels: a level drops parts whose bounds diameter spans fewer than this many pixels
   * (1080 rows, 60° field of view) where it takes over.
   */
  pixelError: number
  /** Levels of detail per proxy, at most. */
  lodLevels: number
  /** Proxy builds in flight on the worker pool. */
  jobsInFlight: number
  /** Main-thread ms per frame for gathering cells into jobs (at least one cell a frame). */
  gatherMs: number
  /** Bytes of proxy geometry committed per frame (at least one proxy a frame). */
  uploadBytes: number
  /** Frames with no change to a cell's members before it's gathered. */
  settleFrames: number
  /** What proxy windows (structure's window panes) draw as: dark, so no interior shows. */
  windowColor: [number, number, number]
  /** Occluders merge per square region this many metres on a side, capped in triangles. */
  occluderRegion: number
  occluderTriangles: number
}

export const HlodSettings = defineResource<HlodSettingsValue>('hlod/Settings', {
  description:
    'HLOD proxies (0073): levels, budgets for gathering and committing, window colour, occluders.',
  init: () => ({
    enabled: true,
    pixelError: 1.5,
    lodLevels: 3,
    jobsInFlight: 4,
    gatherMs: 0.5,
    uploadBytes: 4 << 20,
    settleFrames: 2,
    windowColor: [0.02, 0.02, 0.025],
    occluderRegion: 32,
    occluderTriangles: 256,
  }),
  hostWritable: true,
})
