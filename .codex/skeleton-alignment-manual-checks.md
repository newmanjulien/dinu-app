# Skeleton alignment: manual checks

Browser verification is intentionally left to the user. Compare loading and loaded layouts
at a narrow phone width and a wide desktop width; slow requests/module loading as needed.

| Screen/state | Expected transition |
| --- | --- |
| Onboarding: Get started with your team | Same centered 760px region, heading/description wrapping, two illustrated cards, stacked phone cards, progress dots, and footer placement. |
| Onboarding: Join your team | Bordered invitation cards resolve to company/inviter/action rows. A settled empty inbox shows the existing empty state. |
| `/template` and `/contracts/new`, template readiness unresolved | Only workspace chrome and a compact loading region appear until readiness is known. |
| Template missing, admin | Setup heading/description keep their wrapping; upload-area placeholders resolve within the same 780px region. |
| Template missing, other member | Setup resolves to the waiting panel, without an upload placeholder. |
| New contract, template ready | Preview background remains behind a neutral creation dialog while installation status is unknown. It resolves to either the name form or HubSpot picker; Cancel and error recovery remain usable. |
| Company invitation | Account, module, and preview loading use the same invitation frame. Unknown invitation/identity shows common structure. Known signed-in resolution shows one action placeholder; known valid signed-out entry matches the code-request action. Invalid/expired and retry flows still work. |
| Support booking | Introduction remains visible. Loading includes heading, month navigation, date grid, times, and timezone footer. Times stack below dates until the booking region reaches 520px, then sit beside them. |
| HubSpot deal picker | Initial rows load inside the bordered results box below search. Existing results remain during same-query refresh; selected deal, eligibility, empty/error states, and search keep working. |
| Delete account | Pending membership options show explanatory text only. The confirmation input or ownership-transfer instruction appears once its mode is known. Check Cancel; no deletion is necessary for visual verification. |
| Past links: version preview | Loading and loaded documents share phone/desktop top and bottom padding, with no document heading. |
| Integrations catalog/detail | Admin loading resolves to catalog/detail geometry; other members get restricted-panel geometry. Unknown role stays minimal. Unknown/coming-soon detail slugs resolve to the unavailable panel. |
| Delayed/failed account loading | One loading/status announcement per region, and Try again/Log out remain accessible. Check reduced motion suppresses placeholder pulsing. |

Automated checks validate types, existing authentication/recovery guarantees, SSR availability,
and bundle dependency boundaries. They do not prove visual alignment at these breakpoints.
