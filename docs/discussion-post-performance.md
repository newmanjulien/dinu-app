# Discussion root validation comparison

Phase 1 browser timing samples were not saved, so there is no historical end-to-end latency
number to compare honestly. The backend work changes from reading and composing every document
chunk for each root comment to reading the current manifest and its revision-bound passage index.
Replies still use the thread's stored tape length and do not read document wording.

An offline CPU comparison on a synthetic 300-paragraph document checked 300 anchors against both
validators, then timed 30 warmed-up validations through each path:

| Path                                              | 30 validations |
| ------------------------------------------------- | -------------: |
| Full document composition plus passage validation |       248.9 ms |
| Cached index decode plus passage validation       |        25.1 ms |

The compressed index was 7,624 bytes. This is about 9.9 times less local validation CPU in that
fixture. The comparison excludes Convex reads, network time, authorization, and the rest of the
write transaction; it is not a posting latency measurement.

New ordinary document writes store the index when their transaction has spare capacity. Existing
documents populate it on a successful root write. Deferred root validation uses the same cache
and can populate it. An index over 512 KiB is skipped; those revisions retain exact full-document
validation. The index is checked against document ID, revision, ownership, and manifest seal before
use, and contract/company cleanup removes it.
