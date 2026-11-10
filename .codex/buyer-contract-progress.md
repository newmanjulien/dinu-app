# Buyer contract-only change

Scope: remove the buyer form and readiness workflow; keep header empty at existing height; open contract at short buyer URL. Preserve Word export, link version controls, seller history/copy feedback, activity cookies and one opening per entry.

Decisions: keep contractBuyerState latest-link pointer. Stop exposing/writing form data; retain optional legacy schema fields until a bounded internal cleanup is run. No production deployment or data deletion.

Evidence: BuyerShell.svelte, BuyerContractPage.svelte, buyerLinks.ts, buyerValidators.ts, openings.svelte.ts, api/buyer/open endpoint. Contract content/export excludes form fields.

Baseline copies of affected existing files: /tmp/oceans-buyer-contract-baseline. Repository already contains extensive user changes.

Completed: UI, routes, contract owner, backend API cleanup, optional legacy schema fields and bounded removeFormData operation; docs and existing fixtures updated. Form UI/session/validation modules deleted. Cookie/activity and shared copy-feedback paths preserved.

Verification passed: npm run test:perf (36 tests), npm run test:loading:ssr (12 tests), existing loading-recovery tests (5), Convex tsc, npm run build (Svelte check 0 errors/warnings plus tools type check), npm run verify:loading-bundles, scoped git diff --check. No new tests or browser checks.

Completed final review against the task baseline. Development push succeeded on disciplined-squid-496 via convex dev --once --typecheck enable; schema and functions accepted. Production was not deployed and the form-data purge was not executed.

Remaining release/manual actions: deploy the frontend through the normal release; execute the documented form-data cleanup on the chosen deployment when authorized; browser/Word acceptance. Optional legacy validators can be removed after all supported deployments are purged.
