# Buyer help and search — complete

Scope: shared normal-contract search/rail, buyer-specific help (auto-open when readable; separate hide preference), remove Review the contract heading + skeleton. Blank header and lazy document loading preserved. No backend/cookie changes. No plan skill or subagents.

Implementation: account-free DocumentTools extracted from WorkspaceChrome; public BuyerDocumentHost enables buyer tools; historical previews retain existing controls. Buyer download moved into tools with connection/eligibility guards, cancellation on detach/destroy, and error retry. BuyerShell hosts existing header overlay. Frame removes heading API/placeholder and desktop spacing, retains mobile tool clearance.

Verification: production build (includes Svelte check: 0 errors, 0 warnings + tools tsc), loading-bundle boundaries, performance suite 36/36, targeted search-overlay and loading-recovery tests 10/10, SSR tests 12/12, scoped formatting/diff checks all passed. No new tests, browser checks, deployment, commit, or push. Buyer help auto-opening/persistence, visual placement and shortcut flows remain for manual browser verification.

Evidence: /tmp/oceans-buyer-tools-baseline; /tmp/oceans-buyer-tools.patch; /tmp/oceans-buyer-tools-{build,perf,lifecycle,ssr}.log.
