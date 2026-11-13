# Document-loading audit remediation

Status: implemented; all six accepted findings addressed.

Scope: Q-01/Q-02/P-01/P-02/S-01/S-02 from the completed deep audit. Preserve unrelated workspace changes. No backend changes, UI redesign, font mechanism, new tests, browser checks or deployment.

Completed:

- Cold selected-definition failures keep the existing viewer Retry before a render source exists; SavedContract resets presentation/opening deadline and retries the editor.
- Reservations distinguish bounded intent from established navigation. Matching repeated capture preserves the navigation token and lifetime; genuine navigation attempts retain isolated cleanup.
- Final detach, deletion and destruction replace every editor-owned lazy view payload cache with empty data. Pending/failed saving, journals and recovery remain owned. One shared readiness derivation serves all consumers.
- WorkspaceScope alone constructs/configures/destroys the template source. Audience sessions require injection. Independent admitted-route and mounted leases replace the read-owner mirror and share the underlying subscriptions.
- Two existing fixture factories inject/destroy their source. No assertions changed. Loading/ownership documentation is reconciled; the approved font policy is unchanged.

Fresh automated validation:

- `npm run test:perf`: 37/37 tests passed across seven files (saving, caching, creation and scheduler assertions preserved).
- `npm run test:lifecycle`: 92/92 lifecycle tests across 13 files and 12/12 SSR tests across two files passed (opening/recovery, authoring lifetimes, retained rendering and existing shared-feedback assertions).
- `npm run build`: passed Svelte checks with zero errors/warnings, tool type checks and production adapter output.
- `npm run verify:loading-bundles`: passed public-frame, Contracts and buyer-entry heavy-dependency boundaries.
- Prettier check for all ten changed source/fixture files and `git diff --check`: passed.
- Static inspection plus installed Svelte compiler output confirm retirement evaluates each payload derivation, readiness is shared, all source consumers use the scope owner, and the template read-owner mirror is gone.

Evidence: `/var/folders/6w/_vvn6r6d6hbc9vrdf9ds6dsr0000gn/T/oceans-loading-remediation-44l55_2w` contains the affected-file baseline, `implementation.patch`, check logs, `verification.json`, `acceptance-notes.md` and compiled editor inspection. Audit plan: `/var/folders/6w/_vvn6r6d6hbc9vrdf9ds6dsr0000gn/T/oceans-document-loading-audit-87ueut08/final-plan.md`.

Remaining user-run acceptance: cold-local rejection/retry in retained/fallback viewers; repeated/held activation during actual Kit navigation; template opening/Settings/audience/access transitions; detach/reopen during pending or failed saving. Existing mocks do not certify the exact cold-local retry, real network overlap or heap release. Actual heap quantity/duration, latency, CPU, font pixels, native selection and clipboard output remain unmeasured. No measured speedup is claimed. No implementation work remains.
