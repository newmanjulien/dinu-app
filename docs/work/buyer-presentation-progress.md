# Buyer-link presentation

Scope: approved implementation of unified audience state, page-owned document and rail,
independent history, and shell-scoped discussion recovery. Preserve seller draft vs
latest-publication preview semantics, write fences, downloads, and copy feedback.

Evidence: BuyerShell mounts the host separately from BuyerContractPage; the host manually
reparents its DOM. BuyerContractPage and DocumentTools each own a rail. DiscussionSession
clears drafts and exact pending operations on destruction. Preview ignores the version
URL while ContractVersions mutates it.

Baseline: working tree contains extensive preexisting changes; status snapshot at
`/tmp/oceans-buyer-shell-status-before.txt`. Do not revert unrelated changes.

Progress: implementation and validation complete.
- Neutral checking/unavailable chrome and explicit seller classification retry.
- Host/error boundary now live in BuyerContractPage's ordinary DOM. Detach releases
  preparation/presentation generation, preventing old success from satisfying remounts.
- One BuyerUtilityRail with document capability bindings and dynamic interaction ownership;
  page-level authorized history survives preparation and leaves seller URL intact in preview.
- DiscussionRecovery retains drafts and exact operations by token/account/version/projection;
  subscriptions/auth/focus remain session-owned. Old settlements affect only their own work.
- Existing SSR/loading tests: 16 passed. Performance suite: 39 passed.
- Final production build/type/tool checks passed with zero Svelte diagnostics.
- Loading dependency boundary verification and git diff whitespace check passed.
- No new tests or browser checks.

Automated guarantees checked: existing saving/scheduling/caching performance assertions;
neutral buyer SSR chrome and private-content exclusion; existing loading/recovery and
provider lifetime assertions; TypeScript/Svelte diagnostics; production compilation;
lazy document dependency boundaries. These existing tests do not prove the new draft
recovery or visual rail behavior.

Manual checks remaining: cold signed-in/anonymous entries, repeated seller/preview
switches (desktop/mobile), history selection/restoration, Search/Help/Versions with
Escape/outside-click/focus, account changes and classification retry, composer/reply/edit
drafts and pending sends across switches, alias route navigation, and downloads.
