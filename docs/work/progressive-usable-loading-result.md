# Progressive usable loading implementation

Implementation follows [the executable plan](progressive-usable-loading-plan.md).
Contracts owns a persistent usable search input above lazy results. After verified account
admission, scoped saved cards and buyer links hydrate from IndexedDB without waiting for
the results module or live queries. The visible cards filter as search changes, and saved
cards remain usable while the live page refreshes. A slow IndexedDB open may still finish
later in the same session; a failed optional first-page read no longer deletes that page.
Creation admits its
business form and valid submission before renderer readiness, then transfers confirmed
creation into one canonical saved editor/resource opening without speculative draft rendering.
Saved/template viewers reveal three exact closed pages together, or the complete shorter
document after pagination, and append actual remaining pages while custom interactions wait
for complete readiness.

Saved ContractRoute owns the initial functioning Help modal, resolved preference and one
session per destination/account opening above lazy code, host, authority and document/search
readiness. Dismissal and focus survive preparation/retry; A→B→A creates fresh openings and
old preference writes cannot affect replacements. Naming tears down before automatic Help.
Search code is separate from lightweight Help. Both rails admit an ordered applicable prefix
while resources prepare independently; shared integration failure/timeout and search-code
failure provide local ordered retry controls. Templates retain manual help and public buyers
retain their preference/preview policy and page-owned Download.

Feature-local regression tests are included in `test:snappiness` and the normal component
suite. The final `npm run verify` passed: 5 SSR, 107 backend, 32 client, 136 component and
41 performance tests, zero-error/warning Svelte/tools checks, production build and loading
bundle boundaries. These checks cover composition/cache identity, progressive rendering,
persistent search input through lazy results, canonical creation/handoff and route Help/tools.

See [performance checks](../performance-checks.md) for automated guarantees and
[rendering snappiness](../rendering-snappiness.md) for ownership/readiness behavior.
Physical browser paint, native scrolling/selection/caret, responsive layout, accessibility
delivery and live provider/network behavior remain user acceptance. No browser automation,
backend redesign, commit or deployment was performed by this implementation.
