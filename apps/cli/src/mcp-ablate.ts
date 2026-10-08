// MCP tool for perf.ablate (spec 0075), in its own file so the profiler's tools (0074) sit next to
// it without touching it.

import type { JsonSchema } from '@aethervtt/shard-core'
import { ABLATE_METHODS } from '@aethervtt/shard-protocol'
import type { McpContext } from './mcp'

function schemaOf(method: string): JsonSchema {
  const schema = ABLATE_METHODS.find((m) => m.name === method)!.params.jsonSchema()
  delete schema.$schema
  delete schema.title
  delete schema['x-version']
  return schema
}

export const ABLATE_TOOLS = [
  {
    name: 'ablate_passes',
    description:
      'Each render pass\'s real GPU cost: disables passes in turn and reports how much gpu:frame drops (median over interleaved rounds). Use it when per-pass times look wrong, as on Apple and other tile-based GPUs, where passes overlap and their times add up to more than the frame. Slow: about (passes + 2) × rounds × (frames + 4) frames, so name the passes you care about (render.describe lists them) and lower frames for a quick look. Example: { "passes": ["gizmos", "upscale", "tonemap"], "together": true }.',
    inputSchema: schemaOf('perf.ablate'),
    run: async (ctx: McpContext, args: Record<string, unknown>) => ({
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(await ctx.target().request('perf.ablate', args), null, 2),
        },
      ],
    }),
  },
]
