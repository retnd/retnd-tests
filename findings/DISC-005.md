# DISC-005: plain `retention` is a preview, because FR-20 deletion is unimplemented

- **Filed as**: [spdrman/rclone-manager#21](https://github.com/spdrman/rclone-manager/issues/21) (pre-existing)
- **Pinned by**: `suites/cli/cases/retention/apply-is-not-implemented.yaml`
- **Positive control**: `suites/cli/cases/retention/apply-announces-it-is-preview-only.yaml`
- **Build**: `rclone-manager` at `8ad310014b5be92e75789c8cff4167942d0c8e42`

## Contract

`docs/EPIC.md` FR-20 defines local deletion safety, which only has
content if local deletion happens. The usage line offers `retention
[--dry-run]`, and a `--dry-run` flag distinguishes a preview from a real
run; without an apply mode there is nothing for it to be distinguished
from.

## Observed

Plain `retention` prints exactly what `retention --dry-run` prints, plus:

```
note: local deletion (FR-20) is not implemented anywhere in this codebase yet (issue #21 is open); this is a preview only, identical to --dry-run.
```

## Why it is recorded here rather than filed anew

This one is already known, already filed as #21, and the binary says so
itself on its own output. It is in the list because the suite has to take
a position on it: the case asserts the documented apply contract and is
marked against #21, so when deletion lands the case goes red and forces
the marker's removal.

The paired control asserts the note is present today. If the note ever
disappears without deletion arriving, that control goes red, so the
divergence cannot become invisible.
