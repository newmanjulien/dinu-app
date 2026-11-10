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

## UI styling

- Put static UI styles directly in inline Tailwind classes on the rendered elements.
- Avoid custom spacing or size props, shared class-string modules, and CSS variables
  for ordinary visual styling. Standard `class` attributes and semantic component
  variants are fine.
- Keep shared theme tokens, animation keyframes, and computed document or floating
  layout geometry where they serve a functional purpose.

### Buyer link copy confirmation

- Preserve the UI approved in conversation `01a1b72d-7332-7be0-9db9-2b9b74217b03`:
  “Latest link copied” in the shared `StatusBubble` used for “Changes saved”,
  centered in the workspace status area, raised 8px to clear Home's search bar,
  and dismissed 2.5 seconds after the latest successful copy.
- `BuyerLinkController` reports successful clipboard writes through its required
  `onCopied` callback. Wire it to `BuyerLinkCopyFeedback.show`; render the single
  `CopyConfirmation` host in `WorkspaceShell`. This covers Home cards, the contract
  bar, its options/create-link actions, and Past links without per-button state.
- Keep this path intact when refactoring cards, menus, or workspace chrome. If the
  bubble disappears, repair the controller-to-host path. Do not replace it with a
  button-anchored tooltip or a modal. Keep the workspace status visible above the
  Past links dialog. The manual-copy fallback is only for clipboard failure.

## Context management

- Read relevant file sections and targeted search results. Avoid dumping
  entire large files, reports, or command outputs into context.
- For long or multi-stage tasks, keep a compact progress file with scope,
  decisions, evidence pointers, completed work, and next steps. Update it
  at meaningful checkpoints so work can resume after compaction.
- Keep detailed evidence in artifacts; use concise summaries and pointers
  in conversation. Read the underlying evidence when needed to verify claims.
- When using subagents, prefer fresh contexts with self-contained handoffs.
  Request compact results with artifact paths, findings, and unresolved gaps.
- Context efficiency must not reduce investigation depth or omit findings.
  Skip progress artifacts for simple tasks.

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`src/convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->
