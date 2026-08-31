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
| DISC-001 | [#187](https://github.com/spdrman/rclone-manager/issues/187) | `artifacts` answers a nonexistent backup set with an empty list and exit 0 |
| DISC-002 | [#188](https://github.com/spdrman/rclone-manager/issues/188) | `validate` blames the argument count when the real problem is flag ordering |
| DISC-003 | [#189](https://github.com/spdrman/rclone-manager/issues/189) | `version` silently accepts unknown flags where every other command exits 2 |
| DISC-004 | [#190](https://github.com/spdrman/rclone-manager/issues/190) | `daemon` exits 143 after handling SIGTERM, so a normal stop looks like a crash |
| DISC-005 | [#21](https://github.com/spdrman/rclone-manager/issues/21) | plain `retention` is a preview: FR-20 local deletion is not implemented |

## Open contract questions

Not every disagreement is a divergence. Where the documentation does not
say what the right answer is, there is nothing to mark expected-to-fail,
and pretending otherwise would put a marker on a case that the product
could never satisfy or violate. These get filed as questions, recorded
here, and pinned by cases that assert only what holds whichever way the
question is answered.

| Finding | Issue | Summary |
|---|---|---|
| DISC-006 | [#192](https://github.com/spdrman/rclone-manager/issues/192) | FR-18 never says which timestamp puts an artifact in a retention bucket, and the two readings disagree about whether an ingested backlog survives |
