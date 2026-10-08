// perf.ablate (spec 0075): per-pass GPU cost by disabling passes in turn and reading gpu:frame.
// In its own file so the profiler's perf.* methods (0074) sit next to it without touching it.

import { defineSchema, Last, PostUpdate, t } from '@aethervtt/shard-core'
import { ablatePasses, Gpu, Graph, Views } from '@aethervtt/shard-render'
import { type App, AppControlResource } from '@aethervtt/shard-runtime'
import type { MethodDef } from './server'

/** A frame without advancing time (no loop, or a paused one), as render.capture renders. */
function renderOnly(app: App): void {
  app.runSchedule(PostUpdate)
  app.runSchedule(Last)
}

function nextFrame(app: App): Promise<void> {
  return new Promise((resolve) => {
    const off = app.onFrame(() => {
      off()
      resolve()
    })
  })
}

export const ABLATE_METHODS: MethodDef[] = [
  {
    name: 'perf.ablate',
    description:
      "Each render-graph pass's GPU cost, measured honestly on any GPU: rounds alternate the pass disabled and enabled, and its cost is the median drop in gpu:frame (first pass start to last pass end). Use it where per-pass timestamps overlap (tile-based GPUs such as Apple's, where pass times add up to more than the frame). A disabled pass still begins and ends, so what reads its textures stays valid; the image is wrong while it runs. Needs timestamp-query. It runs (passes + 2) × rounds × (frames + 4) frames: three passes at the defaults take about 50 s at 60 fps.",
    params: defineSchema('protocol/AblateParams', {
      passes: t.list(t.string, {
        description:
          'Render-graph nodes to measure (render.describe lists them). Default: every node the last frame ran.',
      }),
      frames: t.u32({ default: 120, min: 1, max: 10000, description: 'Frames per measurement.' }),
      rounds: t.u32({ default: 5, min: 1, max: 100, description: 'Interleaved rounds.' }),
      together: t.bool({ description: 'Also measure every pass disabled at once.' }),
    }),
    handler: async ({ app, world, options }, p) => {
      const manual =
        (options.frames ?? 'manual') === 'manual' || world.resource(AppControlResource).paused
      const frame = () => (manual ? renderOnly(app) : nextFrame(app))
      const graph = world.resource(Graph)
      const gpu = world.resource(Gpu)
      // Compiled pipelines first, so the baseline isn't a frame with draws skipped.
      for (let i = 0; i < 20; i++) {
        await frame()
        await gpu.pipelines.whenIdle()
        if (i > 0 && gpu.pipelines.pending === 0 && gpu.pipelines.skipped === 0) break
      }
      let passes = (p.passes as string[] | undefined) ?? []
      if (passes.length === 0) {
        const ran = new Set<string>()
        const perView = graph.describe().perView as Record<string, { order: string[] }>
        for (const view of world.resource(Views).list) {
          for (const name of perView[view.name]?.order ?? []) ran.add(name)
        }
        passes = [...ran]
      }
      return ablatePasses(
        world,
        {
          passes,
          frames: p.frames as number,
          rounds: p.rounds as number,
          together: p.together as boolean,
        },
        frame,
      )
    },
  },
]
