# Seller version heading

Scope: implement the approved shared seller heading on buyer-link and dashboard views. Keep buyer/preview rails, reuse history rows, and preserve bottom-bar copy/error feedback. No backend or persistence changes.

Decisions: only Vn opens a popup below the token; dashboard buyer-current heading adds an inline link in a new tab; one-entry history remains clickable; unavailable names use “the buyer”. Historical copy: “This is V1, which is now read-only”.

Evidence: ContractVersions owns history/navigation; BuyerContract.displayed identifies the mounted buyer document; RepWorkspace persistence.confirmed plus live history classifies dashboard versions. DocumentTools.onTools suppresses its default rail, so use narrow search controls instead. FloatingSurface needs an optional explicit owner for the page-owned heading.

Completed: shared SellerVersionHeading with anchored FloatingSurface, keyboard/focus handling, and explicit document owner; seller history exposure for single-entry/loading/error states; seller buyer-link and dashboard wiring; removed obsolete dashboard rail version forwarding; search mutual exclusion (including find shortcut); lifted latest buyer-link read while preserving the bar/controller feedback. Buyer/preview rails remain available. Existing unrelated changes preserved using an implementation-start backup for scoped review.

Validation: `npm run build` passed, including zero Svelte errors/warnings, tools TypeScript checks, client/server compilation, and Vercel adapter output. Scoped diff/whitespace review passed. Inspected compiled heading output to confirm spaces around inline Vn and the comment link; preserved bottom-bar sentence verified in compiled output. Existing copy callbacks/error timers and version navigation remain intact. Build log: `/tmp/seller-version-heading-build.log`. No new tests or browser checks. Saving/scheduling/caching were not changed, so perf suite is not applicable.

Status: implementation and automated validation complete. Visual placement, mobile layout, keyboard interaction, live publication updates, and buyer/preview behavior remain for the user's UI check.

Audit follow-up: fixed both verified low-priority findings in SellerVersionHeading. Keyboard navigation returns early when no enabled rows exist and ArrowUp selects the last row when focus is on the popup wrapper. History rows render only while open; ContractVersions retains its fetched history and pagination state outside that guard.

Follow-up validation: `npm run build` passed with zero Svelte errors/warnings, tools TypeScript checks, and production compilation. Log: `/tmp/seller-version-heading-audit-fixes-build.log`. No tests or browser checks ran; delayed-history keyboard behavior and reopen interactions remain unverified in the browser. Saving/scheduling/caching were not changed, so the perf suite is not applicable.
