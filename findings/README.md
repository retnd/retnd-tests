# Contract versus observed

Every file here records a place where `rclone-manager`'s real behaviour
disagrees with what its documentation, its own usage text, or its own
stated conventions say it should do.

The rule that produced them is the one thing that keeps this repository a
validator rather than a change detector. When a case is written, its
expectation comes from a document. When the binary then does something
else, the expectation does not move. The disagreement gets written down
here, filed against `rclone-manager`, and the case is marked
`known_discrepancy: spdrman/rclone-manager#N` so the runner treats it as
a strict expected failure.

Strict means both directions:

- while the discrepancy stands, the case is red and that is the expected
  outcome, so the suite as a whole stays green;
- the moment the marked dimension starts agreeing with the contract, the
  case fails on purpose, because a marker for a fixed discrepancy is a
  lie. Whoever fixes it has to remove the marker and the finding, which
  is what stops this directory quietly rotting into a list of things that
  used to be true.

A marker can name specific dimensions (`known_discrepancy_dimensions:
[exit]`), and it should whenever only some of them disagree. Marking a
whole case expected-to-fail because one dimension is wrong would also
stop anyone noticing if its other three regressed.

Each finding names the contract source it was derived from, quotes the
observed behaviour, and links its filed issue and its pinned case.

## Open

| Finding | Issue | Summary |
|---|---|---|
| DISC-007 | [#211](https://github.com/spdrman/rclone-manager/issues/211) | the Web UI's API client calls fourteen `/api/v1` operations neither the contract nor the engine has, so four pages cannot load against a real backend |
| DISC-008 | [#633](https://github.com/spdrman/rclone-manager/issues/633) | the mock API's CANDIDATE test connection hands its `archive` boolean to the report builder's `deliverable` parameter, so an ordinary storage class is reported as unable to take delivery and no destination can be saved in the browser, while the one class a retention tier is refused for would be waved through |
| DISC-009 | [#634](https://github.com/spdrman/rclone-manager/issues/634) | a retention tier created after the default destination is moved starts on the old one, because the two cards on the settings page hold separate reads of it; and a tier added to a backup set's own policy never consults the default at all |
| DISC-010 | to be filed | clicking a backup lands an operator on the Dashboard: an artifact id is three URL segments and `/backups/:artifactId` is one, so the detail page and everything on it is unreachable in a browser. The same defect was found and fixed on the neighbouring backup-set route in #285 |

## Resolved

A finding leaves this directory when the product agrees with the contract
again, because a file describing behaviour that no longer exists is worse
than no file: the next reader cannot tell which entries are still true.
What replaces it is the case, which stays and now asserts the contract
strictly, with no marker to relax it. The row below is the pointer, so
that "this used to be wrong" stays findable without the stale write-up.

The pin moves with the fix, every time: until it does, none of these
cases can see the change that resolved them. DISC-001 through DISC-004
went out together with
[#209](https://github.com/spdrman/rclone-manager/pull/209) and the pin
moved to `defa0a6`. DISC-006 went out with
[#215](https://github.com/spdrman/rclone-manager/pull/215) and the pin
moved to `612b48c`. DISC-005 went out with
[#465](https://github.com/spdrman/rclone-manager/pull/465), whose own
branch carries `scripts/e2e/tests-repo.pin` forward to this repository's
side of it; `build-under-test.json` still has to follow it here.

DISC-005 resolved the other way round from the rest of this table, and
that is worth writing down rather than smoothing over. The product did
not come round to the expectation; the document the expectation was
derived from turned out to be the wrong one to derive it from. The usage
line offered `retention [--dry-run]`, so a case was written asserting
that plain `retention` applies, and it never could: FR-20's deletion is
real, but it is authorised against a `plan_id` an administrator reviewed,
and a CLI apply would be a second, weaker path to the same act. So the
usage line moved to say the flag is inert there and the case moved with
it. The rule the rest of this file describes is intact. An expectation
still never moves to match a binary; this one moved because the contract
it came from was corrected, which is a different thing and has to stay a
different thing.

| Finding | Issue | What it was | The case that now asserts the contract |
|---|---|---|---|
| DISC-001 | [#187](https://github.com/spdrman/rclone-manager/issues/187) | `artifacts` answered a nonexistent backup set with an empty list and exit 0 | `artifacts/nonexistent-backup-set` |
| DISC-002 | [#188](https://github.com/spdrman/rclone-manager/issues/188) | `validate` blamed the argument count when the real problem was flag ordering | `validate/operand-after-flags`, with `validate/unknown-flag-after-operand` and `validate/double-dash-ends-flags` bounding the accommodation |
| DISC-003 | [#189](https://github.com/spdrman/rclone-manager/issues/189) | `version` silently accepted unknown flags where every other command exits 2 | `version/no-config-flag`, plus `version/rejects-an-operand` for the other way it says no |
| DISC-004 | [#190](https://github.com/spdrman/rclone-manager/issues/190) | `daemon` exited 143 after handling SIGTERM, so a normal stop looked like a crash | `daemon/sigterm-stops-cleanly`, which now also asserts the shutdown log that used to be a race |
| DISC-005 | [#21](https://github.com/spdrman/rclone-manager/issues/21), settled by [#431](https://github.com/spdrman/rclone-manager/issues/431) | plain `retention` printed that FR-20 local deletion is not implemented anywhere in this codebase and that #21 is open, months after #21 landed it; the usage line implied an apply mode the CLI deliberately does not have | `retention/plain-retention-is-a-preview`, which asserts the note that replaced it and, on the state dimension, that the invocation which looks destructive changes nothing |
| DISC-006 | [#192](https://github.com/spdrman/rclone-manager/issues/192) | FR-18 defined the retention buckets and never said which timestamp put an artifact in one, so an ingested backlog collapsed into a single daily, weekly and monthly bucket and five artifacts out of six were delete candidates on the very first pass | `retention/gfs-tiers-from-one-ingest`, with `retention/override-flags-narrow-the-itemisation` showing the same fixture under a narrower chain and `retention/every-artifact-is-kept-or-deleted` still holding the partition |

## Open contract questions

Not every disagreement is a divergence. Where the documentation does not
say what the right answer is, there is nothing to mark expected-to-fail,
and pretending otherwise would put a marker on a case that the product
could never satisfy or violate. These get filed as questions, recorded
here, and pinned by cases that assert only what holds whichever way the
question is answered.

There are none open right now. DISC-006 was the one, and
[#215](https://github.com/spdrman/rclone-manager/pull/215) answered it by
writing the missing rule into FR-18: an artifact is placed twice, once by
the discovery timestamp and once by the producer's own timestamp where
that one is admissible, and KEEP is the union. It is in the Resolved
table above.

The section stays because the mechanism is the point, not the current
count. A question recorded here and pinned by a case that survives either
answer is what stops the alternative, which is guessing at an answer,
writing it into a case, and discovering months later that the guess is
now the contract because nobody remembered it was a guess.
