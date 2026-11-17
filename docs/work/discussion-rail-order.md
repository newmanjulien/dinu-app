# Discussion rail ordering

## Phase 1: layout contract

The desktop discussion rail keeps the existing anchor order, including the current same-line tie break. Selecting a card changes its preferred position and possibly its measured height; it does not give that card permission to pass another card. A card that was before the selected card in anchor order stays above it.

Order must also stay stable through a selection-only geometry refresh. The selected range requests precise geometry ahead of other ranges, and the packer sorts each fresh `anchorTop`. The rail retains its established order after selection and through page mounting while scrolling; a document, card-anchor, or document-width change can establish a new order.

For ordered cards `0..n-1`, with top `p[i]`, measured height `h[i]`, and the existing 6 px gap:

- `p[0] >= 0`.
- `p[i + 1] >= p[i] + h[i] + 6` for every adjacent pair.
- `bottom = max(p[i] + h[i])`, or `0` for an empty rail.

Anchor positions are preferred positions, after clamping them to the rail top. Order, non-overlap, and the rail-top boundary take precedence over exact anchor alignment. A selected card sits at its measured anchor whenever those constraints permit it. If all preceding cards cannot fit above that anchor, the selected card moves down only by the missing space. No earlier card is moved below the selected card to make room.

## Placement rule for phase 2

1. Compute the normal forward-packed positions from all anchors, as today. This is also the entire result when no selected card has a measured target.
2. For a selected card at index `s`, set its top to the greater of its clamped measured anchor and the minimum space needed for all preceding card heights and gaps. That minimum is `sum(h[0..s-1]) + 6 * s`.
3. Walk preceding cards backward. Place each at the lesser of its normal position and the latest position that leaves the required gap before the next card. This moves only the cards that need to rise.
4. Walk following cards forward, placing each at the greater of its anchor and the previous card's bottom plus the gap. This lets cards return toward their anchors when space opens.
5. Derive `bottom` from the final placements.

Positions are computed afresh from current anchors and measured heights, so selecting, expanding, collapsing, and remeasuring do not accumulate offsets. The last exact anchor is retained through temporary geometry gaps. The highlight controller's zero-size page-top placeholder is never cached as an exact anchor. With no measured or retained selected anchor, ordinary forward packing remains the fallback. The shared review-tag caller uses that fallback; mobile cards remain in document flow and do not use these desktop positions.

For the recorded case, “Hi” precedes “Test.” When “Test” rises to its anchor, “Hi” rises enough to preserve their gap. If “Hi” cannot fit above the anchor because the rail starts at zero, “Test” stops at the first position below “Hi.”

## Phase 3 and final verification

Phase 3 keeps measured height, anchor, selection, stable order, and rail-bottom inputs in sync with this contract. Final verification covers the recorded case and the top-boundary, equal-anchor, missing-anchor, height-change, and multiple-card cases. Automated checks run only after implementation; browser behavior remains for the user's manual check.
