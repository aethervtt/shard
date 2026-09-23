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
