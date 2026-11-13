# Skeleton consolidation

Scope complete: removed TeamSkeleton, ContractsSkeleton, SettingsSkeleton,
ContractSettingsSkeleton, IntegrationCatalogSkeleton, IntegrationAccessSkeleton,
and OnboardingSkeleton. No backend/session logic edits or browser checks.

Shared layouts now serve loading and loaded screens: TeamLayout, ContractsLayout,
SettingsLayout, ContractSettingsLayout, IntegrationCatalogLayout, OnboardingLayout.
IntegrationAccess renders the real static message. Onboarding reuses the company
choice cards with interaction disabled while loading. Settings copy is shared in
settings-fields.ts and contract-settings-fields.ts; SettingsCardPlaceholder keeps
small field/avatar placeholders. Existing row/grid/buyer-link skeletons remain.

Checks passed:
- npm run check: zero Svelte errors/warnings; tools TypeScript checks passed.
- npm run test:perf: 36 tests.
- npm run test:loading:ssr: 5 tests.
- Focused loading-boundaries and home-snappiness lifecycle suites: 11 tests.
- npm run build and npm run verify:loading-bundles: production build and startup
  dependency boundaries passed.
- git diff --check; no references to removed components in src/tests/scripts.

The focused lifecycle tests caught an early loading ResizeObserver introduced by
moving the contracts section. Measurement now lives only in loaded contract
content; both focused suites pass without test changes. No new tests were added.
Browser appearance/responsive transitions and unrelated routes remain unverified.
