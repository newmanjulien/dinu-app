# Fundamental selection: Phase 2 break owner and DOM endpoint contract

Each displayed `BreakOccurrence` has one `.selection-break-owner` sibling of its adjacent
`BlockFragment` in `.document-content`. The owner is identified within the committed page
by `data-selection-break-owner` (physical occurrence order) and `data-selection-group`
(the break group's identity). It exists for every displayed break, including breaks
without saved annotations, and remains the same selection node when its nested
`StructuralBoundaryControls` add, remove, or change buttons. The owner contributes no
line box or pagination space. Its control child positions targets and buttons over the
existing visible gap. Neither the owner nor its controls carry a source target; the
selection model supplies source boundaries and aliases.

## Endpoint mapping for native import

Let `O` be the owner and `P` its parent, with `O` at child index `i`. The physical
break is the indivisible display interval `[0, 1]` for that occurrence. A later native
importer should apply these rules after confirming that the DOM range belongs wholly
to the active selection surface:

| DOM endpoint | Ordered range start | Ordered range end |
| --- | --- | --- |
| Anywhere inside `O`, including any control descendant | Break offset `0` | Break offset `1` |
| `(P, i)`, immediately before `O` | Break offset `0` if the range continues through `O` | The preceding displayed endpoint; `O` is excluded |
| `(P, i + 1)`, immediately after `O` | The following displayed endpoint; `O` is excluded | Break offset `1` if the range started before `O` |

The importer should also recognize equivalent ancestor element offsets that resolve
to these same edges. A range spanning both outer edges includes one break even when
there is no text node in the gap. An endpoint inside `O` includes the break regardless
of its child index or which optional button is mounted. Reversing anchor and focus
changes only direction, not the ordered extent. An endpoint exactly outside `O` must
not pull the break into a range that heads away from it. Two endpoints within `O` can
represent a gap-only extent when the captured document selection is noncollapsed.

Interactive controls remain excluded from document text and from ordinary mouse drag
starts. An endpoint inside a control is a structural position, not selected control
text. The full DOM text envelope must still reject genuine unowned text, unsupported
content, and positions outside the active mounted surface. Source eligibility is
decided only after the complete display extent is mapped. These endpoint rules are a
contract for the native importer; this phase establishes the stable owner without
changing native endpoint translation.
