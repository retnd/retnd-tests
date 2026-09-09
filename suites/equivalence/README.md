# Suite C: Web UI to CLI equivalence

```sh
cd suites/equivalence && npm ci && npx playwright install chromium   # once
RM_UI_DIR=/path/to/rclone-manager/ui/shared npm test
```

Or from the repository root, `make suite-c`.

The claim is stronger than either other suite makes alone: **everything the
Web UI does to the backend, the CLI does identically, and the proof is the
resulting backend state rather than the rendered page.**

`MATRIX.md` is the checked-in coverage matrix: every backend-mutating or
materially state-revealing UI function, its CLI equivalent, and what
equivalent state means for that pair. Where there is no equivalent in
either direction, the row says so. Where a pair exists but cannot be
proved today, the row says why and names the issue.

## How a row is proved

1. Materialise one fixture scenario **twice**, into two work directories
   that start bit-identical. Not one copied twice: the fixture layer is
   deterministic by construction, and `specs/harness.spec.ts` asserts that
   two materialisations really do agree before anything else runs.
2. Boot the real engine over the first directory, on a port this process
   picked, and the real production UI bundle in front of it. The bundle is
   `vite build` output, where `import.meta.env.DEV` is false, so
   `createMockApi` is compiled out entirely and every request the page
   makes is a real one to a real engine.
3. Enrol an administrator over HTTP and sign in through the real login
   form. Enrolment is setup, not an action being compared, which is why it
   goes over HTTP; the credential is generated per run, held in memory, and
   never written to disk or passed through argv.
4. Perform the action through the browser on the first directory, and
   through `rbm` on the second. One row drives the API directly
   instead of the browser, and says so in the spec: the wizard's own path
   to creating a backup set goes through a live host-key probe, which
   opens a real SSH connection to a machine no fixture here has. Driving
   `POST /backup-sets`, which is what the wizard calls, is the honest
   comparison this fixture can make; the wizard's own steps are a
   different row and are still blocked.
5. Compare the two with `tools/equivstate`.

## The comparison, and what it forgives

`tools/equivstate` is Go, next to `statesnap`, and Suite C shells out to it
rather than reimplementing it. If the two sides of an equivalence test
could disagree about what state IS, the comparison would be about nothing.

It compares two things:

- **the filesystem**, through `statesnap`: byte digests for every file.
- **the product's own read surface**: `sources`, `artifacts`, `status`,
  `check` and `retention --dry-run`, run against both directories with the
  same binary. This is the better oracle wherever it reaches, because it
  compares what an operator can observe rather than an internal
  representation two correct implementations could legitimately differ on.

The catalog is compared through the read surface rather than by raw rows,
because two independent runs write different ingest timestamps into it.

What it forgives is an argument, never a default:

- `--ignore-file SUFFIX` drops a file from the filesystem half, and the
  spec that passes it says in a comment why. Three suffixes are used
  today: `config.yaml`, whose two copies differ in ways that are not a
  divergence; `local-auth.json`, which only the UI side has, because a
  browser has to sign in and the CLI has no way to enrol an
  administrator; and `local-auth.json.lock` beside it, a
  process-lifetime advisory flock whose presence says which side still
  had a server up rather than what either side wrote.

  `config.yaml` is worth one more sentence, because the two rows that
  ignore it do so for different reasons and one of them compares it
  anyway. In the settings row it is written by the engine's YAML writer
  on one side and by hand on the other, so the two are textually
  different and semantically the same, and the read surface is what
  settles whether they agree. In the create row both surfaces reach the
  same `core/service` method, so the two files come out of the same
  writer and the only thing that differs is the work directory inside
  their absolute paths: that spec compares them directly, path-normalised,
  and passes the suffix only so the byte-digest half does not report the
  paths as a difference.
- `--mask-volatile` masks the four values that belong to the machine and
  the moment rather than to the backend: absolute timestamps, durations,
  relative times, and the host filesystem's free-space reading. It applies
  to the read surface and to the text content of files whose bytes differ,
  which is what lets a sidecar recovery manifest recording the same facts
  at a different second compare equal. It does not mask sizes, counts or
  state names, and `tools/equivstate`'s own tests prove that: one case puts
  a real difference on the same line as a timestamp and requires it to
  survive.

Every one of those behaviours has a paired negative control in
`tools/equivstate/equivstate_test.go`. A differ nobody has seen fail is not
a differ, and this one has been seen to fail on each dimension separately.

## What it proves today

Three rows: the backup-set list read, the retention-policy write, and
creating a backup set. `MATRIX.md` says which, and says plainly that the
number is a finding rather than a scope decision: against a real backend,
four of the six pages cannot load, because `ui/shared/src/api/client.ts`
calls fourteen `/api/v1` operations neither the contract nor the engine has
([#211](https://github.com/spdrman/rclone-manager/issues/211),
`findings/DISC-007.md`), and the two mutating actions that would matter
most are refused by a destructive gate that is hardcoded shut pending
[#92](https://github.com/spdrman/rclone-manager/issues/92).

`specs/contract-gaps.spec.ts` pins every one of those blocks against a live
engine, in both directions. A blocked row that starts working turns that
spec red, which forces `MATRIX.md` to be updated rather than left to rot.

That is the same mechanism Suite A's `known_discrepancy` marker uses, and
it is here for the same reason: a document that records what is missing is
only useful if something notices when it stops being missing.
