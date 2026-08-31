# DISC-002: `validate` blames the argument count for a flag-ordering problem

- **Filed as**: [spdrman/rclone-manager#188](https://github.com/spdrman/rclone-manager/issues/188)
- **Pinned by**: `suites/cli/cases/validate/operand-after-flags.yaml`
- **Positive controls**: `suites/cli/cases/validate/happy.yaml` (flags first works),
  `suites/cli/cases/validate/wrong-argument-count.yaml` (the genuine arity error)
- **Build**: `rclone-manager` at `8ad310014b5be92e75789c8cff4167942d0c8e42`

## Contract

The usage banner carries two lines that have to be read together:

```
validate <source/backup-set/artifact>          re-check one artifact's durable local copy
...
every command except version accepts --config (default /etc/backup-manager/config.yaml)
```

Together they say the command takes one operand and also accepts
`--config`. Neither says the two have to be written in a particular
order.

## Observed

```
$ backup-manager validate production/app-uploads/uploads-2026-06-01.tar --config ${CONFIG}
backup-manager: validate takes exactly one argument: <source/backup-set/artifact>
$ echo $?
2
```

The same invocation with the flag first succeeds.

## Why this is a divergence and not an ambiguity

The parsing behaviour is ordinary `flag` package behaviour and is
defensible on its own. The message is not: it reports a wrong number of
arguments, when exactly one operand was supplied and the flag was in the
wrong place. It sends the reader to check the artifact id, which was
correct. An error that describes a different problem from the one the
operator has is worse than no error text at all, because it costs them
the time to rule out what it named.
