# Buyer presentation audit remediation

User authorized implementation after the completed deep audit. Authoritative plan:
`/tmp/oceans-buyer-audit-XBqgXLwy/plan.md`; verified findings and diagnosis are in
the same directory. Preserve the approved UI, seller/buyer source and URL rules,
authorization fences, lazy boundaries, and shared copy feedback.

## Work

- R-01: synchronous live Search observation and shared controlled utility panel.
- R-02: scoped undelivered successful-create identities; direct draft owner access.
- R-03: finite first/older history and download acquisition, with silent lifecycle cancellation.
- R-04: suppress duplicate automatic viewer bootstrap and overlapping name refresh.
- R-05: specialize buyer document props; remove adapter and unused seller API.

## Decisions and validation

- No new tests or browser checks. Required integration checks: `npm run test:perf`,
  `npm run build`, `npm run verify:loading-bundles`, targeted formatting and diff checks.
- Use a local 60-second download acquisition budget as the plan's provisional
  implementation default; actual production export tolerance is unmeasured.
- Working tree has extensive existing changes. Baseline status is retained at
  `/tmp/oceans-buyer-remediation/baseline-status.txt`; do not revert unrelated work.

## Status

All five work groups are implemented; source review and integration checks continue.

- R-01: live getter replaces copied Search state; `UtilityPanel.svelte` owns the
  common shell/registration/trigger/focus behavior with one bound owner state.
- R-02: `DiscussionDrafts.created` retains operation UUID → thread ID until a
  current authorized feed/own-created reader accepts the result. Pending handoffs
  cannot be evicted by the 20-reader bound. Scalar/map forwarding removed.
- R-03: history first/older acquisitions use 15-second attempts; downloads race
  headers and body against a 60-second attempt, separate from reset ownership.
- R-04: successful viewer acceptance satisfies automatic bootstrap; overlapping
  shell name refreshes share admission until settlement.
- R-05: required buyer token and unconditional tool binding; deleted adapter,
  redundant props, and unused dashboard getter.
- Concurrent Help work changed shared component contracts during implementation;
  preserve it and its shell-owned HelpSession when inlining the buyer tools.

Source review also added destruction cancellation for deferred panel focus and
cleared history cursor/done state at source replacement, preventing a prior
source's Older versions request from being admitted before the new first result.

Implementation complete for R-01–R-05, covering all ten findings and both linked
cause records. `npm run test:perf`: 39 passed. Final `npm run build` passed,
including zero Svelte/type errors or warnings and tool checks. Final
`npm run verify:loading-bundles` passed (public frame, Contracts, buyer contract
entry). Targeted formatting and `git diff --check` passed. First build's nullable
trigger type was fixed; concurrent Help contracts are integrated. No implementation
or automated gate remains pending; manual acceptance below is unexecuted.

## Manual acceptance still outstanding

- Search → Versions, Versions → Search, and the find shortcut: one open panel,
  correct input/row focus, Escape return focus and outside dismissal on desktop/mobile.
- With over 20 earlier comments, post and switch views while the create is pending;
  return to the same account/version/projection before and after completion. The
  created row should appear without restoring old focus. Other scopes stay isolated.
- History first/older acquisition timeout (15 seconds), download header/body timeout
  (60 seconds), retry, late completion, source replacement, and intentional teardown.
- Cold seller/anonymous entry, view switching, selected seller URL restoration,
  read-only latest-publication preview, aliases, latest-publication download.
- Shared “Latest link copied” bubble placement, timer reset, Past links overlay,
  and existing clipboard/error feedback.

These outcomes have source traces and compiler coverage, not runtime/browser
reproduction. Existing performance fixtures cover their established saving,
scheduling and caching guarantees; they do not cover the new panel/late-create/
transport-stall scenarios. No new tests, test edits, browser checks, backend edits,
deployment or live-data operations were performed by this remediation.

## Evidence

- `/tmp/oceans-buyer-remediation/perf.log`
- `/tmp/oceans-buyer-remediation/build.log`
- `/tmp/oceans-buyer-remediation/bundles.log`
