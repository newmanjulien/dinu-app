# Instructions and explanations rename

Scope: rep guidance is Instructions; buyer-facing text is Explanations; shared code uses TemplateItem/TemplateAudience. Implement approved recommendation across model, editor lifecycle, backend names, copy, and current docs. Preserve database shapes, IDs, revision/snapshot formats, shared saving/geometry, and existing buyer-link feedback. No new tests or browser checks.

Baseline: preexisting extensive worktree changes preserved. Original text files saved outside repo; backup path recorded in /tmp/oceans-instructions-rename-backup.

Decisions:

- RepInstruction and BuyerExplanation form TemplateItem. Rep storage stays implicitly rep; buyer storage already has audience + explanation.
- Remove authoring-item.ts buyer-to-instructions.summary conversion. Real union flows through draft/save/conflict/recovery.
- Keep playbook storage subsystem/table names; neutralize mixed-purpose types/validators/operations. Retain temporary API exports for older open clients.
- Complete per-audience copy, including errors/accessibility, via small message map. Copy action names the actual source: Copy rep summary.

Completed: traced implementation/guidance; captured baseline; renamed types/validators and shared operations; removed buyer-to-summary adapter; carried union through drafts/save/conflict/recovery; updated per-audience copy and accessibility; renderer consumes only rep replacement bodies; shared ClauseText display is neutral and buyer panel/accessibility labels say explanation; updated current docs and affected existing test fixtures/selectors.

Validation: required performance suite passed (39 tests across 7 files). Focused existing authoring lifecycle passed (14 tests across 2 files), including audience session independence, preloading bounds, cold panel selection/cancellation and projection stability. A renamed aria-label selector was maintained without weakening its guarantees. Final type/tool checks and production build passed with zero Svelte errors or warnings. Scoped formatting and git diff whitespace checks passed.

Review: compared against the saved pre-task baseline, preserved legacy admin endpoints and temporary canonical API aliases. No new tests, browser checks, live backend actions or migrations. Implementation and review complete.

Deployment not attempted; database/storage formats unchanged.

Follow-up review complete (no audit skills): found that retained viewers mount under DocumentHost, outside TemplateWorkspace's annotation-label context. Fixed the retained viewer's resource-specific context so buyer-template highlights say explanation. Cleaned up shared capacity wording/comments, the rep panel label, account-deletion copy and two current documentation references. Reviewed the union through creation, editing, save normalization, conflict/recovery and structure projection; no save-data regression found. No draft/save logic changes; no new tests.

Follow-up validation: 39 performance tests and 17 focused authoring/viewer lifecycle tests passed. These exercise existing saving/version, cache, preload, cold-opening and mounted-page stability guarantees. Svelte/tool type checks passed with zero errors or warnings; scoped formatting and git diff whitespace checks passed. The buyer-specific retained label was verified by tracing the context path; existing tests do not directly assert that label. No browser or live deployment checks, and no new production build in this follow-up. Logs: /tmp/oceans-instructions-review-perf.log, /tmp/oceans-instructions-review-lifecycle.log, /tmp/oceans-instructions-review-check.log.

Evidence artifacts: /tmp/oceans-instructions-perf-final.log (39/39), /tmp/oceans-instructions-lifecycle.log (14/14), /tmp/oceans-instructions-build-final.log (successful final build/check), /tmp/oceans-instructions.diff (scoped pre-task baseline diff). Browser behavior, live Convex deployment validation and live data were not inspected or changed. No new tests were added.
