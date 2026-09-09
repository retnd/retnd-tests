# Which build is under test

`build-under-test.json` is the pin. It is checked in, so "what did this
suite certify" is a property of the repository rather than of whoever ran
it, and moving to a newer build is a reviewable one-line change.

```json
{
  "mode": "source",
  "commit": "612b48cf72b5bfa91e999116bc07067407678c12",
  "version": "612b48c",
  "source_builder": "go",
  "image": ""
}
```

## The three modes

### `source`

Clone `rclone-manager` at `commit` into a per-commit cache directory and
build the binaries from it. This is the only honest mode today, because
nothing has been pushed to `ghcr.io/spdrman/backup-manager` yet.

`source_builder` chooses how:

- **`go`** compiles `./cmd/backup-manager` directly. Seconds, no Docker,
  and enough for the CLI contract, which is what Suite A tests. The
  package path keeps the old spelling; the command it produces calls
  itself `rbm`.
- **`docker`** builds `container/Dockerfile` and copies `/backup-manager`
  and `/backup-manager-web` out of the resulting image. Slower, and the
  only route that produces the artefact operators actually receive, so it
  is what the integration runs and Suites B and C use.

The plan for this work specified the Dockerfile route for source mode. I
implemented both and defaulted to `go`, because Suite A does not need the
image and a multi-minute image build in front of a twelve-second suite
would get skipped rather than run. The choice is a field in the pin, so
switching is a data change and both routes are covered.

**The `docker` route and the rename.** From 0.3.3 the image's binaries are
`/rbm` and `/rbm-web`, and `/backup-manager` and `/backup-manager-web`
are symbolic links beside them so an operator's existing scripts keep
working. Extraction still asks for the two old paths, and it now passes
`docker cp -L`, because `docker cp` copies a link *as a link*: without
the flag what lands on the host is a four-byte dangling link to `/rbm`,
and the next thing that happens is the identity handshake trying to exec
it. Measured on a two-line image with that exact layout, not reasoned
about: `docker cp` produced a symlink of size 4, `docker cp -L` produced
the binary. Following a link is a no-op on a pre-rename image, where both
paths are ordinary files, so the one flag spans both sides of the rename
and the extraction still needs to know nothing about which name is which.

What that does **not** check is that the image contains both names at
all. A `/backup-manager` that stopped being built would fail this
extraction outright, which is a loud enough signal; a `/rbm` that never
appeared would not, because nothing here asks for it by that name. The
honest check is to extract both and require them to be the same bytes,
and it is not written, because the pin is allowed to point either side of
the rename and a check that has to ask which side it is looking at is not
a check. `suites/cli/cases/global/g6-…` and `g7-…` cover the half that
does not need an image: the binary behaves identically however it was
reached.

### `registry`

Pull the digest-pinned image from `ghcr.io/spdrman/backup-manager`,
extract both binaries, and cross-check their sha256 against
`container/release-manifest.json` **as it exists at the pinned commit**,
not as `main` has it today. A digest pin rather than a tag pin: tags
move, digests do not.

This mode refuses to run right now, loudly, because nothing has been
pushed to that registry. It is written and waiting rather than
half-working, so turning it on later is a pin edit plus a first push.

When it does go live, authentication is `gh auth token | docker login
ghcr.io --password-stdin` at runtime. **The token is never written to
disk**: not to a config file, not to a temp file, not into this
repository.

### `local`

Test a binary from a working tree. Used for the dev loop, and for
`rclone-manager`'s own gate, where the build under test is the commit
being made and a pin would be pointing at the wrong thing.

```sh
RM_MODE=local \
RM_BINARY=/path/to/rclone-manager/core/rbm \
RM_SOURCE_DIR=/path/to/rclone-manager \
make suite-a
```

`local` mode refuses to run unless it is told which commit the binary
claims to be, through `RM_COMMIT` or by reading `HEAD` from
`RM_SOURCE_DIR`. That refusal is the point: an unverifiable build is
exactly the condition that lets a suite report green against something
nobody meant to test.

## The identity handshake

Before a single case runs, in every mode, the harness invokes
`rbm version` and compares the commit it prints against what the pin
promised. It reads the first line under either name the command has had,
so a pin pointing back at a pre-0.3.3 build can still say which commit it
is; the printed name itself is asserted where an assertion belongs, in
`suites/cli/cases/version/happy.yaml`. A mismatch aborts the run.

This is not ceremony. This project has already had a control report green
against a stale dev server on a shared port, built from an entirely
different commit, and nothing about the setup looked wrong at the time. A
filesystem path, a port number and a container name can all be stale
while looking exactly like themselves. A commit the binary prints about
itself is the one piece of evidence that cannot be.

Comparison tolerates abbreviation in either direction (seven characters
minimum, which is the shortest thing git will hand out) and a `-dirty`
suffix on a build made from a modified tree.

## Environment overrides

| Variable | Effect |
|---|---|
| `RM_MODE` | force a mode, ignoring the pin's own |
| `RM_BINARY` | `local`: the `rbm` binary to test |
| `RM_WEB_BINARY` | `local`: the `rbm-web` binary, optional |
| `RM_COMMIT` | `local`: the commit that binary claims to be |
| `RM_SOURCE_DIR` | `local`: a checkout to read `HEAD` from when `RM_COMMIT` is unset |
| `RM_SOURCE_REPO` | `source`: clone from here instead of GitHub; a local checkout path works and is much faster |
| `RM_CACHE_DIR` | where `source` mode keeps checkouts and built binaries |
| `RM_TAGS` | run only the cases carrying one of these tags, for example `smoke` |
| `RM_KEEP_WORK` | keep each case's fixture work directory for inspection |

## Moving to a newer build

Edit `commit` and `version` in `build-under-test.json`, run `make gate`,
and read what breaks. A case that starts failing is either a regression
in the product or a contract this suite had wrong, and the two are told
apart by going back to the document the case's `contract:` list names.

A case marked `known_discrepancy` that starts *passing* also fails, on
purpose. That is a fixed discrepancy asking to have its marker and its
`findings/` entry removed.
