# Fundamental selection: Phase 1 interaction contract and failure record

Scope: document the current selection behavior and the reported failure before changing the implementation. This phase makes no code or test changes.

## Interaction contract

- `SelectionDocument` is the complete snapshot's ordered sequence of displayed text and real break occurrences. Its positions identify physical occurrences and offsets; break groups carry exact source boundary aliases. A visible gap can therefore be selected even when it contains no text node.
- A claimed ordinary mouse drag resolves its start, movement and release through page geometry. Page padding and visible paragraph gaps participate in that hit testing. A click in a gap is a click, while a drag confined to a gap can select its insertion boundary. A drag from text into a gap, across empty lines, or through a gap into later text retains the full displayed extent in either direction.
- Keyboard selection, multi-click, reserved pointer gestures, pen and touch use the browser's native selection. Native completion captures the final DOM range, direction and owning selection surface. The importer must translate a wholly owned native range into the same ordered display extent and source target as the equivalent mouse gesture, including a range whose DOM endpoint falls on the gap's control structure.
- A normalized gap-only extent is an insertion target and paints a bar. A span containing ordinary text remains one text target even when it traverses gaps; those separators participate in displayed selection and copy. Selection direction, source offsets, repeated displayed occurrences, and exact saved boundary aliases must survive mapping and later validation. Saved gap targets must reopen at their current visible break.
- The full selected envelope determines eligibility. Source-backed text and whitespace keep their exact offsets. Genuinely unowned visible text or whitespace, unsupported content, stale positions, and a range that cannot be completely represented remain ineligible for authoring; the importer must not silently crop them to a nearby valid target. Browser selection and native copy remain available for native-only content. A fully modeled extent supplies the app's plain-text and safe HTML copy, including one newline per shared break.

The established lifecycle details are in [Source selection and validation](../lifecycle.md#source-selection-and-validation). The relevant adapters are `selection-model.ts`, `document-selection.ts`, `selection-gesture.ts`, `selection-surface.ts`, and `dom-selection.ts` under `src/lib/document/selection/`.

## Captured failure

The reported native range starts at the end of `Party."` and ends inside the visible gap's controls. The user intended to select that valid source-backed text-to-gap span. Native import instead reports `hasExtent: false` and `unavailable: "unowned"`, and the UI shows a red selection error. This is a false rejection of the reported gesture; it does not establish that unowned document content was selected.

The current paths explain the discrepancy but do not yet prove the exact failing branch for this capture. Mouse drag hit testing can return a `BreakOccurrence` from the gap rectangle. Native import first checks the DOM text envelope, then tries text-node endpoint bindings and scans selected text nodes; it only adds a break when the range encloses both edges of a break owner. A range ending *inside* the controls may therefore have no mapped high endpoint or complete break, even though the same physical span is expressible in `SelectionDocument`. `nativeOnly()` then returns no extent or target with `unavailable: "unowned"`. The original DOM range, endpoint nodes/offsets, ownership classification, and break-owner relationship need to be traced together before choosing a fix.

## Phase 1 boundary and later acceptance

No implementation or browser behavior has been changed in this phase. A later fix should accept the captured text-to-gap gesture and its reverse without weakening full-envelope source validation. Check gap click versus drag, gap-only insertion, spans over empty lines, native and keyboard gestures, direction, copy, saved target reopening, and rejection of genuinely unowned content. The reported capture is user evidence; its exact DOM topology and the proposed failing branch have not been independently reproduced here.
