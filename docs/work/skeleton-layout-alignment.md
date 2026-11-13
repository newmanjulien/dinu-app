# Skeleton layout alignment

Scope: share presentation markup for workspace navigation, Guides, contract cards/grid,
booking calendar, team rows, buyer links, and document panel; finish integration details.
Preserve loaded behavior, clipboard feedback, and backend. No new tests or browser checks.

Completed:
- AppHeaderLayout owns tab geometry for AppHeader and WorkspaceSkeleton.
- GuidesLayout owns page/card layout for both states.
- ContractGrid and ContractCardLayout share grid, card spacing, and action positioning.
- CsmBookingLayout, CsmCalendarLayout, and CsmCalendarDates share the calendar frame,
  columns, date table/cells, month navigation, and timezone placement.
- TeamListLayout and TeamRowLayout share colleague/invitation list and row geometry.
- BuyerLinksLayout owns section, list, rows, and activity positioning in both states.
- DocumentPanelSkeleton uses DocumentPanelRail and PlaybookCard; unresolved panels
  remain hidden on mobile as before.
- IntegrationDetailsLayout shares the detail page frame, header, sections and screenshots.

Review: existing template menu callbacks, contract observer/prewarming handlers,
CopyBuyerLink controller-to-feedback path, buyer activity controls, team callbacks and
calendar date keyboard handlers remain wired through the presentation components.

Validation completed:
- npm run build: passed, including Svelte/type/tool checks (zero errors/warnings).
- npm run test:perf: 36 checks passed across 7 files.
- npm run test:loading:ssr: 5 checks passed across 2 files.
- npm run verify:loading-bundles: passed for public frame, Contracts and buyer entry.
- Prettier check: passed for all affected Svelte files.
Logs: /tmp/skeleton-build-final.log, /tmp/skeleton-perf-final.log,
/tmp/skeleton-ssr-final.log.

Unverified: visual matching in the browser and end-to-end menu/copy/booking interactions.
Data-dependent text, badges, row counts and provider status can change loaded heights;
shared structural spacing does not predict data that is not available while loading.
