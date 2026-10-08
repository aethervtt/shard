# Specs

Every non-trivial feature starts here as one markdown file. A spec is short, and it's the
contract an implementation is checked against.

## Lifecycle

`draft` → `accepted` → `implemented` (or `superseded by NNNN`)

1. **Draft.** Copy `_TEMPLATE.md` to `NNNN-slug.md` (next free number). Fill in every section.
   Keep it under ~300 lines; if it's longer, split it.
2. **Accept.** A human reads it and flips the status. Open questions must be answered or
   explicitly deferred first.
3. **Implement.** Build it until every acceptance criterion passes. If the design has to change,
   edit the spec in the same change; the spec describes what was built, not what was planned.
4. **Implemented.** Status flips once the criteria pass in CI.

## Rules

- Acceptance criteria are testable statements, not goals. "Spawning 100k entities takes under
  50 ms in the benchmark", not "spawning is fast".
- API sketches are TypeScript. They're a proposal; names can change during implementation.
- Decisions that affect other specs go in the spec's **Decisions** section with a one-line reason.
- `ROADMAP.md` orders the specs. Update it when a spec is added, split, or finished.

## Performance budgets

Time budgets are data (0075). `bench/perf/machines.json` names the machines they apply to
(`laptop`, `desktop`), and `bench/perf/budgets.json` holds every budget by key, with a number per
machine and a note.

- State a budget as a slice of a named scenario (`scatter-walk`'s `gpu:foliage`), or as a unit cost
  with its basis: "measured", or "proposed: like X". Acceptance criteria name budget keys, not
  hardware. "The reference GPU" or "a fast machine" isn't a budget: name the machine or the key.
- Keys are span names (0074): `frame`, `gpu:<node>`, `render/<node>`, a system's name, a package's
  own spans. A measurement that isn't a span (an import, a load) gets a key in the same
  `package/what` style.
- "As built" records measured numbers per machine, and they go into `budgets.json` in the same
  change. A machine that misses a number gets its own number with a note saying why, instead of an
  entry in `TODO.md`.
- Tests read budgets by key: `budget('ui/layout')`, `budget('scene/load', { count })`,
  `budget('scatter-walk', { slice: 'gpu:foliage' })`. No `budget(<number>)` calls remain
  (`node scripts/budget-literals.mjs`).
