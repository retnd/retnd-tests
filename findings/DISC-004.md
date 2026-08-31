# DISC-004: `daemon` exits 143 after a clean SIGTERM shutdown

- **Filed as**: [spdrman/rclone-manager#190](https://github.com/spdrman/rclone-manager/issues/190)
- **Pinned by**: `suites/cli/cases/daemon/sigterm-stops-cleanly.yaml` (exit dimension only)
- **Build**: `rclone-manager` at `8ad310014b5be92e75789c8cff4167942d0c8e42`

## Contract

`docs/EPIC.md` FR-1: the daemon SHALL handle `SIGTERM`/`SIGINT`, use Go
context cancellation, and shut down without initiating unsafe source
deletion. A stop that the operator asked for and that the process
performed is a successful stop.

`docs/deployment.md` documents running this as a long-lived service, so
an ordinary stop is a routine event.

## Observed

The daemon does handle the signal. It logs its own shutdown:

```
{"...","msg":"daemon shutting down","event":"daemon_stop","reason":"context canceled"}
```

and then the process reports 143, which is 128 plus SIGTERM's number, the
status a process that never handled the signal would report:

```
$ backup-manager daemon --config ${CONFIG} & sleep 5; kill -TERM $!; wait $!; echo $?
143
```

`cmdDaemon` returns 0 on this path, so something exits the process before
`main` returns.

Second half of the same behaviour: whether `daemon_stop` reaches the
stream at all is a race. It appears every time when stdout is a file, and
did not appear when the harness gave the process a pipe.

## Why this is a divergence and not an ambiguity

Under systemd a main process exiting 143 marks the unit failed unless
`SuccessExitStatus=143` is configured, so `systemctl stop` and every
restart look like crashes: they count against the burst limit and they
alert. Docker and Kubernetes read a nonzero exit on stop the same way.
Nothing in the documentation asks an operator to configure around this,
and FR-1 describes the stop as something the daemon performs rather than
something that kills it.

Only the exit dimension is marked in the pinned case. The rest of that
case stays strict, so the daemon still has to run its first cycle and
commit what it found.
