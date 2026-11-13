# Template release completion

Scope: a released uploaded template completes template setup immediately, independent
of setup-call dates, cancellation, or provider freshness. Other onboarding steps
(instructions, contracts, links, integrations, team) remain separate.

Evidence:
- `templates.activatePendingTemplate` → `saveTemplateVersion` atomically sets
  `company.templateSourceId`; viewer/template upload status/setup hints already use it.
- `csmSetupAppointments.current` and `WorkspaceShell` still expose the setup reminder
  after release; its client previously waited for the appointment end.
- Setup booking/replacement admission checked booking facts without checking release.

Implementation: use the existing released-source pointer for reminder visibility,
revisit admission, setup calendar access, and backend booking/replacement admission.
Preserve appointment history/provider reconciliation and ordinary support calls.
No schema changes, completion flags, migrations, or browser checks needed.

Completed:
- Backend notice and revisit return immediately once the source is released.
- Workspace removes the notice and disallows required-setup calendar access.
- New setup/replacement admission and queued-sender eligibility reject released
  companies; receipt replay/recovery still precedes new-booking admission.
- Updated the existing revoked-membership sender fixture to keep its company
  unreleased, so the new release guard cannot mask the membership guarantee.
- Updated `docs/assisted-template-setup.md` with the completion rule.

Validation passed:
- `npm run check`: Svelte diagnostics and tools type checks.
- `npx tsc --noEmit -p src/convex/tsconfig.json`: backend type checks.
- `npm run test:perf`: 39 tests; repeated after fixture maintenance.
- Targeted existing `csm-preload.test.ts`: 9 lifecycle checks.
- Targeted existing `csm-provider.test.ts`: 7 provider checks.
- Prettier check for all changed source/test files.

No tests added or expanded. Browser appearance, live release and production build
remain unverified. No deployment: `docs/deployment.md` documents incompatible
unpublished schema changes requiring a coordinated cutover; this patch stays local.
