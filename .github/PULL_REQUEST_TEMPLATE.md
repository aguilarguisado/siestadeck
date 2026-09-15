<!-- Thanks for contributing to siestadeck! -->

## Summary

<!-- What does this PR do, and why? -->

## Changes

<!-- Bullet list of the notable changes. -->

-

## Screenshots

<!-- If this changes the rendered output of any action, paste before/after screenshots of the key. -->

## Checklist

- [ ] `npm run coverage` passes (80% gate)
- [ ] `npm run typecheck` passes — this is the type gate, **not** `npm run build`, which reports type errors as warnings and still exits 0
- [ ] `npm run validate` passes
- [ ] `npm run build` passes
- [ ] If a new action: added the manifest entry, the `@action({ UUID })` decorator, and the `registerAction(...)` call in `apps/streamdeck/src/plugin.ts`
- [ ] If new user-facing behavior: updated the README and the relevant `CLAUDE.md`
- [ ] Follows the actions-are-stateless-renderers rule (no I/O, polling, or fetch in `apps/streamdeck/src/actions/`)
- [ ] If it touches `packages/core/`: no host SDK imported, logging goes through `log()`, and anything newly public is in `src/index.ts`
