# Skeleton alignment

Scope: implement the approved plan for onboarding, invitation inbox/entry, template setup,
new contract, support booking, HubSpot deal picker, deletion, buyer version preview, and integrations.
Unknown branches show common structure. No loaded-screen redesign, backend changes, new tests,
browser checks, or plan skill. Preserve recovery, lazy imports, and buyer copy feedback.

The checkout already has extensive unrelated changes. Pre-edit copies of touched files are at
`/tmp/oceans-skeleton-alignment/before` for reviewing this task independently of the existing diff.

Completed: all planned skeletons and fallback selection; task-only code review. Onboarding
shares its static heading/description frame, and its pending wrapper matches the loaded
account wrapper. Invitation preview waits on common structure until its status is known;
valid signed-out invitations already know the email, so they need only the code-request action.
Workspace modal recovery renders inside the dialog so top-layer behavior cannot hide it.

Validation complete on the final source: check passes (0 Svelte errors/warnings), 12 existing
SSR checks and 11 focused lifecycle/recovery tests pass, production build and loading dependency
boundaries pass. Task paths pass `git diff --check`. No tests were added or modified; no browser
checks. Visual matching remains unverified. Manual checklist:
`.codex/skeleton-alignment-manual-checks.md`.
