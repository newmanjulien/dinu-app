# Test reorganization

Scope: reorganize existing assertions by backend/client/components/SSR and feature; split contracts; keep performance/snappiness commands and SSR→hydration ordering. No new coverage or product changes.

Decisions: shared external inputs/transport/Svelte helpers live in tests/support; feature harnesses remain beside their tests. Separate HubSpot/export commands; npm test runs the complete suite. Preserve explicit performance selection.

Evidence: baseline test/config copies and logs in /tmp/oceans-test-reorganization. Original suites: perf 36 passing, integration 87 passing, SSR 5 passing; lifecycle 83 passing / 5 failing (four CSM preload checks and retained-document reuse).

Completed: runtime/feature directories, contract split, shared helper extraction, scoped commands/configs and tests/README.md. Exact token inventory confirms all 185 test declarations (216 expanded cases) preserve their bodies and assertions; only a relative type import moved. Backend 102/102, client 29/29, perf 36/36 and tools type checks pass. Contract split 22/22 passes after fixing extracted helper imports.

Final verification: npm test collected all 216 cases once across 38 files: 211 pass / 5 fail. The failure names and first error lines exactly match baseline (four CSM preload checks and retained-document reuse); no new failures remain. All 22 split contract checks pass. Explicit test:perf passes 36/36; tools type checks, Prettier and scoped git diff --check pass. All 185 test declaration token inventories match baseline, allowing only the relocated relative type import. Logs and machine-readable summary: /tmp/oceans-test-reorganization/{final-tests.log,reorganized-perf.log,tools.log,body-inventory.json,verification-summary.json}.

Complete. No assertions added/removed/weakened, product changes, browser checks, production build or deployment. Baseline failures remain unresolved; native/browser behavior and build output were not reverified.
