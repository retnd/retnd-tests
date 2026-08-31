# DISC-003: `version` silently accepts unknown flags

- **Filed as**: [spdrman/rclone-manager#189](https://github.com/spdrman/rclone-manager/issues/189)
- **Pinned by**: `suites/cli/cases/version/no-config-flag.yaml`
- **Positive control**: `suites/cli/cases/global/f6-unknown-flag.yaml`
- **Build**: `rclone-manager` at `8ad310014b5be92e75789c8cff4167942d0c8e42`

## Contract

The usage banner's closing line is "every command except version accepts
--config", which marks `version` as the command where that flag has no
meaning. The binary's own convention answers an unrecognised flag with
exit 2, through `flag.ContinueOnError` for every other command.

## Observed

```
$ backup-manager version --config /nowhere/config.yaml
backup-manager 8ad3100
rclone v1.75.0
go go1.27.0
commit 8ad310014b5be92e75789c8cff4167942d0c8e42
$ echo $?
0
```

`cmdVersion` builds no flag set, so anything after the command name is
ignored rather than rejected.

## Why this is a divergence and not an ambiguity

"Does not accept `--config`" and "ignores `--config`" are different
promises, and only the first is documented. The cost lands on scripts: a
caller that tries `version --json`, a reasonable guess, gets exit 0 and
human-readable text, and fails later at whatever tries to parse it. Every
other command in the binary catches this class of mistake at the point it
is made.
