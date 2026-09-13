# DISC-012: `backup-set create|patch` reports none of the incremental fields it wrote

- **Filed as**: to be opened against `backupdproject/backupd` (see "Filing")
- **Pinned by**: `suites/cli/cases/backup-set/create-reports-every-field-it-wrote.yaml`
  (the `stdout` dimension only)
- **Build**: observed on `backupd` at
  `4ffc25fb1b8980a85fccc1cb6d9795f23b297569`
- **Kind**: a report that documents itself as complete and is not, on the
  newest half of the surface it reports about.

## Contract

The binary's own usage text:

> A routed create or patch reports every field it wrote, stale_after
> included: the API carries stale_after_seconds now, so both routes print
> the same set (#555)

and the flags it accepts, from the same text:

> [--engine artifact|kopia] [--repository-domain D] [--source-consistency S]
> [--verification-level L] [--verification-sample-percent N]
> [--verification-full-every D] [--verification-restore-drill-every D]

So a create that wrote those keys reports them.

## Observed

```
$ backupd backup-set create production/api-uploads ... \
    --engine kopia --repository-domain production \
    --source-consistency external_snapshot \
    --verification-level content_full --verification-sample-percent 25 \
    --verification-full-every 168h --no-verify --config .../config.yaml
...
backup set: production/api-uploads
  host: source.example.internal
  port: 0
  user: backupuser
  remote_path: /srv/uploads
  local_path:
  include:
  completion_strategy:
  stale_after: 48h0m0s
  validator_id:
  disabled: false
  read_only: false
  connection: not verified (...)
```

The file afterwards:

```yaml
- id: api-uploads
  engine: kopia
  uuid: a2172041-6ab3-4697-8d9a-8650d0b1ffb6
  repository_domain: production
  source_consistency: external_snapshot
  verification_level: content_full
  verification_sample_percent: 25
  verification_full_every: 168h0m0s
```

Seven keys written, none reported. `backup-set patch` prints the same
artifact-shaped report and has the same gap.

## Why this matters

- Four of the twelve lines the report DOES print are blank, because an
  incremental set has no `local_path`, no `include`, no
  `completion_strategy` and no `validator_id`. Read together with the
  absence of anything about the engine, the report looks like a command
  that ignored its flags -- which is exactly what an operator checking
  their work is trying to rule out.
- It is the only confirmation a scripted rollout gets. A fleet that
  creates sets over the API or the CLI has nothing to assert on, so
  "did every host get `verification_level: content_sample`?" can only be
  answered by reading twenty config files.
- The wizard and the API echo the same service response, so the gap is
  not the CLI's alone: it is in what the create surface returns.

## Suggested shape of a fix

The report is rendered from the service's create/patch response. Carry the
engine, the repository domain, the consistency mode and the four
verification fields on that response and render them, printing the
incremental block only for a set whose engine is `kopia` -- the same way
the artifact-only fields should arguably be omitted for one.

## Scope of the marker

`known_discrepancy_dimensions: [stdout]`. The exit code and the fact that
the configuration changed stay asserted strictly.

## Filing

Produced by the #789 release-gate work. It belongs upstream as its own
issue against the service create/patch response and
`core/cmd/backupd/backupset.go`'s renderer.
