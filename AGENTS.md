# Agent Instructions

## Tests

- Do not create new tests or expand the test suite unless the user explicitly asks for new tests.
- Only use the existing tests if it's absolutely necessary.
- Do not check things in the browser unless it's absolutely necessary. I'll check that myself.
- Do not use Playwright or another similar framework unless it's absolutely necessary.

### Targeted performance checks

These requirements are an exception to the existing-test restriction above:

- Run `npm run test:perf` when changing saving, scheduling, caching, or their tests.
  `npm run verify` runs this suite followed by the type checks and production build.
- Maintain affected fixtures and assertions through refactors. Routine maintenance
  of this suite does not require permission; new coverage is not required for every change.
- Report which automated guarantees were checked and which remain unverified.
- Do not weaken or remove assertions merely to resolve failures. Fix the regression
  or update the affected assertion to preserve its guarantee under the intended behavior.

## Planning changes

when evaluating a change. focus on the target outcome, not the migration cost. lots of churn is fine. lots of work is fine. but we need clean/simple outcomes. less code is good

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`src/convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->
