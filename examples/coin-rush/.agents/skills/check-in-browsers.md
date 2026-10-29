# Check it in real browsers

Headless screenshots are for regressions. Filtering, color and canvas compositing only show in a
browser, and so do real frame times.

1. Write a plan (`.shard/schemas/capture-plan.schema.json`): the URL (`shard dev`'s, or a host
   page), browsers, DPRs, viewport, and shots with a `state` the page's
   `installCapturePage(app, { apply })` understands. `shard dev` pages take shots as they are.
2. `shard capture plan.json --out captures/latest --json` takes them, runs `steps` and their
   `expect` checks in every client, and records each `scenario` (`records/*.json`).
3. `shard compare captures/latest --approved captures/approved --json` diffs against approved
   images (ΔE2000 and SSIM) and writes `report.html`. Changed or new shots fail.
4. A change you meant: `shard approve <shot> --reason "why it looks different"`. A change you
   didn't: fix it. Approvals without a reason are refused.
5. `shard perf-check captures/latest/records --plan plan.json` fails on a broken threshold and
   names the metric, the value and the budget.

With the MCP server attached to a running page: `metrics_reset`, exercise the scene, then
`metrics_record` returns the same record the scripts write.
