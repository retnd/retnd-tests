# Suite C: Web UI to CLI equivalence

Not built yet. This directory holds the preconditions and the shape of
the matrix.

The claim this suite makes is stronger than either of the others makes
alone: **everything the Web UI does to the backend, the CLI does
identically, and the proof is the resulting backend state rather than the
rendered page.**

## Preconditions, in order

1. **Suite B is migrated**, because Suite C drives the browser through
   Suite B's page objects. Building its own would put selectors in two
   places.
2. **The phase gate is clear.** `#158` inherits `#135`'s dependency on
   `#113` and on every Phase 2 through 4 Web UI issue landing first, and
   this estate's rule is that a phase is not done while any open issue
   carries its label. That is a check to run at pickup, not a fact to
   assume: `gh issue list --label <phase> --state open` has to come back
   empty.
3. **The UI surface is re-derived** from the shipped pages rather than
   from any snapshot, including this one.

## Mechanics per matrix row

Materialise a scenario, clone the work directory so both sides start from
bit-identical state, boot the real app against one clone and perform the
action through the browser, run the CLI equivalent against the other, then
compare `statesnap` snapshots of both clones plus, where relevant, each
side's own read surface (`artifacts`, `status`, `sources`, and the
matching `/api/v1` GETs).

The state oracle is not reimplemented in TypeScript. `tools/statesnap`
already answers "what is backend state" for Suite A, and if the two sides
of an equivalence test could disagree about that, the comparison would be
meaningless. Suite C shells out to it, exactly as it shells out to
`mkfixture`.

## Initial matrix

To be re-derived at pickup. As a starting point:

| UI action | CLI equivalent | Equivalent state means |
|---|---|---|
| Dashboard health read | `status` | same per-set verdicts, same exit-code-implied overall health |
| Backups list read | `artifacts` (with filters) | same artifact ids and lifecycle states |
| Sources and backup-set list | `sources` | same ids |
| Run backup manually | `fetch --source S --backup-set B` | catalog rows, local tree digests, sidecar manifests |
| Retention preview | `retention --dry-run` plus matching override flags | identical keep and delete itemisation with tier attribution |
| Retention apply | `retention` | marked against [#21](https://github.com/spdrman/rclone-manager/issues/21) while FR-20 deletion is unimplemented, the same way Suite A's case is |
| Catalog rebuild | `catalog rebuild` | rebuilt catalog equal through the read surface |
| Validate artifact | `validate source/set/artifact` | same resulting lifecycle state |
| Settings write: retention policy | edit `config.yaml` per FR-5, then `check` | effective config as reported by `check` and `retention --dry-run` |
| Add, edit or remove a backup set | edit `config.yaml` per FR-5, then `check` | effective config plus a `sources` read-back |
| Version and build provenance | `version` | same version and commit |

## Gaps are stated, never faked

Where a UI function has no CLI equivalent, or a CLI command has no UI
equivalent, the matrix carries the row with a one-line reason instead of
an invented equivalence. Expected UI-only rows: quarantine and release,
local-auth enrolment and password rotation, host-key trust decisions,
connection tests, the activity feed, live operation progress. Expected
CLI-only rows: `run`, `daemon`, `check`, and possibly `reconcile`
depending on what the Phase 3 pages shipped.
