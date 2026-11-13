# Skeleton copy cleanup

Scope: replace readable loading-content copy with skeleton shapes. Keep navigation,
page/section titles, breadcrumbs, real access/empty states, and usable controls.
Preserve the loaded UI and shared layouts. No new tests or browser checks.

Targets: Contracts and Integrations search placeholders; loading toolbar/row/modal
actions; catalog logos/names/descriptions; settings card text; onboarding choice
content and loading descriptions; template introduction/subtitle; booking skeleton
description, weekdays, and time-zone label.

Evidence: loading copy lives in shared `*Layout.svelte` fallbacks; text inside
`SkeletonBlock` is already invisible. Rep template/access views are real content.
Contracts/Integrations loaded search controls remain usable during data refresh.

Status: implementation complete. Shared loading variants now hide the targeted
copy. Loaded search/disabled permission controls, page/section headings, rep
template/access states, active Cancel and onboarding navigation stay intact.
Calendar changes affect only the full placeholder (not a month refresh). Concurrent
calendar layout extraction was preserved.

Validation:

- Prettier and targeted whitespace/diff review passed.
- `npm run check`: no diagnostics in changed components; failed on three missing
  test helpers (`template`, `headsAfter`) in
  `tests/components/contracts/recovery.test.ts` and `route-editing.test.ts`.
- `npm run test:perf`: 101 passed, one unrelated Word-generation assertion failed
  at `tests/backend/exports/word-generation.test.ts:138` (custom XML relationship
  target path). No backend or test files changed for this task.
- No browser checks or new tests; visual appearance and interactions unverified.
