# Floating UI and interaction ownership

The persistent app layout creates one `InteractionController`. Floating surfaces,
workspace panels, and search register with it; feature components do not add document
listeners for outside pointers, focus dismissal, or Escape. The controller requests
closure with a reason. Authoring still decides whether a clean, dirty, new, or unresolved
box can close, as described in [lifecycle.md](lifecycle.md). Nothing in this layer saves.

`FloatingSurface` uses a manual native popover in the browser top layer when supported.
It stays in its logical DOM location, preserving Svelte context and disabled fieldsets.
On older browsers, the shared positioning layer moves the same surface into a viewport
host and mirrors inherited fonts, colors, local CSS variables, disabled fieldsets, and
inertness. Cleanup restores a still-mounted surface; it never restores a surface or
subtree that Svelte has already removed. Style changes share the positioning frame,
while blocking changes apply immediately. Svelte context and interaction ownership
remain intact. Workspace input capture reaches portaled surfaces through context;
selection tooltips explicitly preserve the accepted selection because portaling changes
DOM event ancestry.
Keep this fallback in `floating.ts`; feature components must not add their own portals,
z-index fixes, or absolute floating coordinates. Native modal dialogs keep
`showModal()`; opening a workspace modal closes transient surfaces, and a modal blocks workspace
dismissal and shortcuts.

Workspace status messages live in `WorkspaceStatus`, a passive manual popover positioned
from the measured app-header height. It preserves the existing status stack and does
not register as an interaction or take focus. A successful buyer-link copy promotes
that stack above other surfaces in the browser top layer.
`BuyerLinkController` calls the required workspace feedback callback only after the
clipboard write succeeds. `CopyConfirmation` renders once in `WorkspaceShell`, using
`StatusBubble`, the text “Latest link copied” (or “New link copied” after creating a
link), the approved 8px upward offset, and a
2.5-second lifetime that restarts with each successful copy. Cards and menus do not
own confirmation state. Keep the clipboard-failure manual-copy fallback separate.

Buyer-link options stay in one dropdown: versions appear newest first in a list
that shows two full rows and part of the third to signal scrolling. Older links
load as the list scrolls, without a “More links” button. Each version opens its saved contract directly in a
snapshot preview; the latest also has a copy action. Earlier versions remain viewable
after replacement. Creating a new link saves and copies the new version. There is no
separate history-list modal.

The options dropdown uses the already-loaded latest link to omit history entirely
when no links exist, leaving only “Create new link”. For existing links, its history
area reserves one or two rows, or two rows and part of the third, based on the latest
version. Loading placeholders use the same row heights. History starts on first open
and remains subscribed until the contract unmounts or the session is blocked, so
reopening preserves the current list and loaded pages.

All modals use `$lib/ui/ModalShell.svelte`. Its `dialog` variant centers a
content-height surface; its `panel` variant fills the available height and supports
right alignment. The shared `--radius-modal` token defines outer corners. Tailwind
classes on the shell elements set header/body padding to 20px and footer padding to
20px horizontally and 18px vertically. Callers set surface widths with inline
Tailwind classes such as `class="max-w-[420px]"`; full-screen mobile panels use
square corners. Only the body scrolls, keeping the header and optional footer visible.

Modal owners control `open` or conditionally mount the shell. Escape, backdrop
clicks, and the close button request `onClose`; the shell stays open until the
owner accepts closure. Use `dismissible` to block these requests while busy,
`showCloseButton` to omit the close control, and `closeOnBackdrop` to keep outside
clicks from dismissing a dialog. `onOpen` can focus and select a form field. Native
dialogs provide background inertness and focus containment; the shared behavior
locks body scrolling and restores available focus without taking it from another
active modal. Company naming and session status retain their dismissal restrictions.

`floating.ts` is the only positioning implementation. Floating UI measures the invisible
surface outside clipping ancestors before revealing it, uses fixed coordinates, applies an offset, flips
and shifts with 8px viewport padding, and constrains available width and height. Large
surfaces scroll internally. Its updates track scroll, resize, content size, and moving
anchors; closing or unmounting releases all observers. An element or a virtual anchor
with a `contextElement` is supported. Removed or disabled anchors close their surfaces.
Tooltips close when their reference is clipped. Selection actions hide while clipped,
keeping accepted native endpoints so scrolling back restores the actions.

Floating surfaces default to content width. Caller width classes take precedence;
only trigger-width matching writes an inline width. Viewport constraints still apply.

## Adding an interaction

Use `Tooltip` for supplementary text, `Menu` for actions, and `Popover` for ordinary
interactive controls. Each has its own semantics and focus behavior:

- `Tooltip` shows on hover or keyboard focus, allows hovering its content, and never
  focuses its content. The standalone info button also toggles on touch. A custom
  trigger receives the snippet's description ID for `aria-describedby` and supplies
  its element reference. Escape suppresses reopening until activation ends.
- `Menu` focuses the checked item or the first enabled item and handles arrows,
  Home/End, and native Enter/Space activation. Call the child snippet's `activate`
  callback when completing an action. Tab dismisses after normal focus traversal.
  Render actions with `MenuItem` to share spacing, hover, keyboard focus, and disabled
  styles. Pass `checked` for a radio decision with a saved-selection checkmark, or
  `danger` for a destructive action. Pointer opening does not highlight the focused
  item; keyboard focus uses a background and outline via `:focus-visible`. Status
  colors on review tags and active navigation underlines belong to their features.
- `Popover` contains normal controls, such as checkboxes. Pass `keyboard` when opened
  by keyboard to focus its first enabled control; pointer opening leaves trigger focus
  intact. Changes inside it do not dismiss it.

Both interactive components restore the available trigger after Escape or activation.
Outside pointers and focus leaving dismiss without preventing the clicked action or
redirecting focus. Preferred placements are below-start for tooltips, below-end for
menus, and below-start with trigger-width matching for options popovers.
Tooltips and menus accept a `placement` override: HubSpot deal hints use below-end
to extend inward from the row's right edge, and review decision menus use below-start
to extend rightward from the document's left-side tabs. All placements retain viewport
flipping and shifting.

A workspace sets an owner symbol through `setInteractionOwner`. `BoxDismissal`
registers that symbol as a panel. Descendant floating surfaces inherit ownership;
`FloatingSurface` provides its own symbol for nested surfaces, which open above their
parent. Its optional `owner` and `boundaries` props handle explicit relationships.
Use the `protectedInteraction()` action on real interaction boundaries such as the
workspace panel, annotation triggers, search, and utility controls. Admin authoring
registers the document stage as protected while its editor is open, so selection
gestures leave the working context intact. Pointer interactions with descendants
count as inside their owners, even when those descendants render in the top layer.
Protected boundaries inherit through the same ownership chain.

Document workspace panels open at the canonical selected source target, independently of
the clicked occurrence used for focus restoration. `document/panel-anchor.ts` resolves
geometry from one committed snapshot and its exact mounted pages. Redline openings prefer
the earliest original source, including struck-through text; effective openings use the
earliest represented source position. Structural targets follow the existing boundary aliases.
`DocumentViewer` then holds that workspace-relative top through same-target previews,
concession changes and pagination, even if the passage moves. Ordinary scrolling carries
the desktop panel with the document; secondary-location picking retains its sticky behavior.
Target switches, source changes, display scale and settled layout epochs can
reanchor. Close or deactivation clears placement; unresolved updates retain the visible
editor and its position. Switch animation starts only when an accepted new target's
guarded placement commits. The 1150px bottom sheet uses the same editor subtree.

Escape closes a visible tooltip first, then the most recently active interactive
surface or search, then the owning panel on a subsequent press. Hidden selection
surfaces do not consume Escape. Dirty-draft and staged-creation safeguards remain in
`AuthoringController`. Registration cleanup closes descendants when their owner disappears;
the persistent dispatcher is released with the app layout.

Saved-contract buyer controls use a fixed bottom bar. Its ResizeObserver publishes
`--buyer-link-bar-height` (functional geometry only); document scroll space, the 1150px
clause sheet and CSM widget reserve that inset. The 1000px mobile tools include DOCX.
Buyer summaries reuse PlaybookCard/PlaybookText and the document's existing gesture,
keyboard and focus infrastructure, with public clause-summary accessibility labels.
