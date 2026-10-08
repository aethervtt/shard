// MCP tools for performance budgets (spec 0075): perf.ablate and perf.budgets, in their own file so
// the profiler's tools (0074) sit next to them without touching them.

import type { JsonSchema } from '@aethervtt/shard-core'
import { ABLATE_METHODS, BUDGET_METHODS } from '@aethervtt/shard-protocol'
import type { McpContext } from './mcp'

function schemaOf(method: string): JsonSchema {
  const schema = [...ABLATE_METHODS, ...BUDGET_METHODS]
    .find((m) => m.name === method)!
    .params.jsonSchema()
  delete schema.$schema
  delete schema.title
  delete schema['x-version']
  return schema
}

const reply = async (ctx: McpContext, method: string, args: Record<string, unknown>) => ({
  content: [
    {
      type: 'text' as const,
      text: JSON.stringify(await ctx.target().request(method, args), null, 2),
    },
  ],
})

export const BUDGET_TOOLS = [
  {
    name: 'ablate_passes',
    description:
      'Each render pass\'s real GPU cost: disables passes in turn and reports how much gpu:frame drops (median over interleaved rounds). Use it when per-pass times look wrong, as on Apple and other tile-based GPUs, where passes overlap and their times add up to more than the frame (describe_perf says "overlapping": true). Slow: about (passes + 2) × rounds × (frames + 4) frames, so name the passes you care about (render.describe lists them) and lower frames for a quick look. The perf overlay then ranks passes by the result. Example: { "passes": ["gizmos", "upscale", "tonemap"], "together": true }.',
    inputSchema: schemaOf('perf.ablate'),
    run: (ctx: McpContext, args: Record<string, unknown>) => reply(ctx, 'perf.ablate', args),
  },
  {
    name: 'describe_budgets',
    description:
      'Performance budgets (spec 0075) against what the running app measures: which named machine this is (laptop, desktop; null with a perf/unknown-machine warning when the host cannot tell), every budget in bench/perf/budgets.json resolved for it with the profiler\'s latest p95, over budget first, and the scenario\'s frame split: each slice\'s measured share of the frame next to its budget share, red ones (verdict "over") first. The scenario is the app\'s App.perfScenario, or "scenario" (scatter-walk, crowd, planet-descent, tabletop-max). Use it to see what eats a frame against what it may take; pnpm bench --scenario <name> measures the same slices headless.',
    inputSchema: schemaOf('perf.budgets'),
    run: (ctx: McpContext, args: Record<string, unknown>) => reply(ctx, 'perf.budgets', args),
  },
]
