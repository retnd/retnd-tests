# The shared fixture layer

One definition of every scenario, consumed three ways: Suite A imports
`fixtures/lib` directly, and the two TypeScript suites shell out to
`fixtures/cmd/mkfixture`, which materialises a scenario and prints a JSON
manifest of absolute paths. Two implementations would eventually
disagree, and the first time they did, one suite would be asserting
against a situation the other could not produce.

## Two rules that are not negotiable

**Nothing here imports `retnd`.** This repository has exactly
what an operator has. The moment it reaches into the product's own
packages it stops being able to catch the contract breaks it exists to
catch.

**Catalog state is seeded by replaying documented operator commands,
never by writing SQLite rows.** A scenario with `state: replay` runs
`retnd fetch` (or `run`) against the fixture and lets the
product build its own catalog. Writing rows directly would bake FR-9's
schema into the fixtures, which is knowledge an operator does not have,
and it would rot silently on the first migration.

The one exception is `state: corrupt`, which writes garbage bytes to the
database path. That needs no schema knowledge at all, which is exactly
why it is allowed.

Replaying does not smuggle the change-detector trap back in. Replay only
sets the stage; every expectation still comes from a document.

A replay that fails is a hard error rather than an empty catalog. An
empty catalog produced by a broken seed looks exactly like one produced
by a correct seed, and every case downstream would be asserting against a
situation nobody meant to create.

## Where time enters

In exactly one place, and only because the product put it there: FR-24's
freshness compares against now, so a scenario has to be able to say how
old something is.

- Artifact `mtime` is a coarse offset (`now`, `now-2h`, `now-90d`). The
  smallest unit is a minute, because a fixture that depends on a
  threshold it is seconds away from is a flake waiting for a slow
  machine.
- The `stale-local` scenario crosses FR-24's threshold by pairing a tiny
  `stale_after` with a `sleep` in the case. That is safe because the
  crossing is one-way: an idle backup set does not become fresh again
  while a test runs, so a slow machine can only make the assertion more
  true.

Everything else is deterministic. Artifact bytes come from a PRNG seeded
from the scenario, backup set, artifact name and its `seed` field, so two
runs on two machines produce byte-identical trees and a digest assertion
means something.

## Scenario shape

```yaml
doc: what situation this represents, and why it is worth having
poll_interval: 15m
sources:
  - id: production
    backup_sets:
      - id: postgres-primary
        remote: {type: local}          # FR-4; no container needed
        include: ["*.dump"]
        completion: {strategy: stable, stable_for: 10m}
        stale_after: 30h
        validation: {hash: sha256}
        artifacts:
          - {name: pg-2026-06-01.dump, size: 4096, seed: a1, mtime: now-2h}
state: replay                          # none | absent | replay | corrupt
```

`raw_config:` replaces the rendered config with verbatim text, after
`${WORK}`, `${STATE_DB}`, `${REMOTE}` and `${LOCAL}` substitution. That
is how the malformed-YAML and failed-validation scenarios say what they
mean without contorting the schema every valid scenario shares.

`remote_path:` and `local_path:` override the defaults and, when set,
suppress the directory creation that goes with them. That is how
`unreachable-remote` is built: a local remote pointing at a directory
that does not exist is genuinely unreachable, and it needs no container.

## What is not here yet

No SFTP-backed scenario. Everything the CLI contract needs is reachable
over `remote.type: local`, and the cases that genuinely need an SSH
endpoint are listed as gaps in `suites/cli/COVERAGE.md`. The pattern to
port when they are written is `core/tests/sftpfixture` and
`core/tests/dockerlease`, ported rather than imported, including the
stale-container sweep, and it needs a design for the throwaway host key
that does not put a credential on disk.
