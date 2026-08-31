# DISC-001: `artifacts` answers a nonexistent backup set with an empty list

- **Filed as**: [spdrman/rclone-manager#187](https://github.com/spdrman/rclone-manager/issues/187)
- **Pinned by**: `suites/cli/cases/artifacts/nonexistent-backup-set.yaml`
- **Positive control**: `suites/cli/cases/fetch/nonexistent-backup-set.yaml`
- **Build**: `rclone-manager` at `8ad310014b5be92e75789c8cff4167942d0c8e42`

## Contract

`docs/EPIC.md` FR-7 makes a backup set's identity the source plus the
set. A `--backup-set` value that appears nowhere in the config names no
identity, so there is nothing for the filter to be a filter over.

The binary's own usage text lists `artifacts [--source S] [--backup-set B]`
as "list journal artifacts", and its own exit-code convention answers an
operational refusal with 1 and a `backup-manager: ` prefixed line on
stderr.

## Observed

```
$ backup-manager artifacts --config ${CONFIG} --source production --backup-set no-such-set
0 artifact(s)
$ echo $?
0
```

The same unconfigured name is refused by the sibling command:

```
$ backup-manager fetch --config ${CONFIG} --source production --backup-set nope
backup-manager: app: no configured backup set named production/nope
$ echo $?
1
```

## Why this is a divergence and not an ambiguity

An empty result has two explanations, and this output cannot tell them
apart: the set exists and has no artifacts yet, or the set does not
exist. Those call for opposite responses from an operator. `fetch`
already distinguishes them for the identical input, so the product itself
has an answer and `artifacts` is not using it.
