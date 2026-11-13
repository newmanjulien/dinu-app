# Publication-bound export implementation

Historical work log. Its draft/successor and publication-based seller-export model is superseded by [the current data model](../data-model.md), [lifecycle](../lifecycle.md) and [retained rollout gates](../deployment.md#backend-ownership-conversion). This log is not a deployment or conversion certificate.

> Historical implementation/review snapshot. Recorded results describe that stage only.
> Contract conversion, tuple-chunk and compatibility instructions below are superseded by
> the [current contract release procedure](../deployment.md#backend-ownership-conversion).
> Read the current architecture in [data model](../data-model.md); no live cutover is certified here.

Scope: Word downloads and native HubSpot Quotes target only an explicitly requested latest publication. Preserve pre-existing workspace changes; no deployment or data operations.

Decisions:

- Export requests replace draft edit revisions with `publicationId`.
- New Word attempts reference the immutable publication directly; legacy tuple provenance remains readable for retention/history only.
- A new publication blocks release/undispatched quote work; internal draft changes do not.
- Download acknowledgment and dispatched quote settlement retain truthful evidence after supersession.
- Same-wording quote reuse requires authorization of the newly requested latest publication and current destination.

Coordination: core agent supplies `publicationFor`, `readVersionContent`, contract version schema, and the `exportRequest` validator. Root owns public download route and browser controls.

Completed: reviewed current approval-bound Word/quote paths, retention, settlement, and existing integration assertions.
Next: replace document boundary, bind Word and quote attempts, maintain existing export fixtures, run backend type check when core APIs stabilize.

Implementation checkpoint:

- `documentExport.requireLatestPublication` checks the captured immutable publication against the current pointer. `latestPublishedExport` reads frozen version definitions/selections and approved provenance; it never composes live approvals/effects.
- Word attempts capture publication title/template/revisions and `publicationId`; new attempts use `publication-v1` provenance. Final release rejects superseded publications. Existing released-download acknowledgments, retention, File reconciliation and legacy tuple codecs remain intact.
- Native Quote content/reservation/pump/start/dispatch use publication identity, current membership and destination. Same-wording remote reuse is gated by the requested publication/destination. Verification/late dispatched settlement remains truthful after draft/publication changes.
- HubSpot activity optionally captures `versionId`; download activity uses the attempt's original publication.
- Existing integration fixture exposes draft version IDs and establishes V1 before exports; reserved-content case then edits the successor. The retention assertion now proves publication reference/title survives byte expiry instead of asserting duplicate tuple storage.

Checks:

- Existing `exports.test.ts`: 10/10 passed.
- Existing full HubSpot integration suite: 59/60 passed. The one remaining activity case removes after reopening approval; new withdrawal semantics restore the approved predecessor. Core agent is supplying the deliberate-removal contract so the existing removal guarantee can be maintained.
- Backend TypeScript check found no export/HubSpot errors; overall errors were concurrent core approval/email edits. Log: `/tmp/oceans-version-exports-tsc.log`.
- Changed export files formatted. No browser, deployments, external provider calls or live data operations.

Remaining: settle the existing removal fixture with core; rerun backend TypeScript once core stabilizes. Root runs final `npm run verify` including perf. Existing suite does not exercise native Quote provider dispatch; behavior there is supported by types and code review, not a provider test.

Latest verification: backend `npx tsc --project src/convex/tsconfig.json --noEmit` passes after concurrent core edits; targeted `git diff --check` passes. Core agent has been asked to supply explicit removal intent for the one remaining activity fixture, without weakening its removal assertion.
