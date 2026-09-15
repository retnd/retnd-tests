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

Clone `retnd` at `commit` into a per-commit cache directory and
build the binaries from it. This is the only honest mode today, because
nothing has been pushed to `ghcr.io/retnd/retnd` yet.

`source_builder` chooses how:

- **`go`** compiles `./cmd/retnd` directly. Seconds, no Docker,
  and enough for the CLI contract, which is what Suite A tests. The
  package directory and the command are the same word from R1.3
  (backupd#888) on: it moved from `core/cmd/backupd` to `core/cmd/retnd`
  in the commit that moved the constant, so a pin naming a build from
  before that rename needs a different package path as well as a
  different binary name.
- **`docker`** builds `container/Dockerfile` and copies `/retnd`
  and `/retnd-web` out of the resulting image. Slower, and the
  only route that produces the artefact operators actually receive, so it
  is what the integration runs and Suites B and C use.

The plan for this work specified the Dockerfile route for source mode. I
implemented both and defaulted to `go`, because Suite A does not need the
image and a multi-minute image build in front of a twelve-second suite
would get skipped rather than run. The choice is a field in the pin, so
switching is a data change and both routes are covered.

**The `docker` route and the rename.** The image's binaries are `/retnd`
and `/retnd-web`. Beside them is exactly one second name: `/backupd-web`,
a real HARDLINK to `/retnd-web`, which R1.5 (backupd#890) kept for one
release because published compose files say
`command: ["/backupd-web", …]` and an upgrade whose first symptom is
`exec /backupd-web: no such file or directory` is not an upgrade. There
is deliberately no `/backupd`: nothing this project shipped ever named it
in a `command:` or a `healthcheck:`.

Extraction asks for the two primary names and passes `docker cp -L`,
because `docker cp` copies a link *as a link*. A hardlink would not need
the flag; the 0.3.3 image's second name was a SYMLINK, and without `-L`
what landed on the host was a four-byte dangling link, with the identity
handshake exec'ing it as the next thing that happened. Measured on a
two-line image with that exact layout, not reasoned about: `docker cp`
produced a symlink of size 4, `docker cp -L` produced the binary.
Following a link is a no-op when both paths are ordinary files, which is
every image from backupd#890 on, so the one flag spans every side of
every rename and the extraction still needs to know nothing about which
name is which.

What that does **not** check is what the image carries under the old
names. A `/retnd` that stopped being built would fail this extraction
outright, which is a loud enough signal; a missing `/backupd-web`
hardlink would not, because nothing here asks for it. The honest check is
to extract both and require them to be the same inode, and it is not
written here, because it is a claim about PACKAGING and this repository
tests the binary: `container/Dockerfile` and the product's own
`apps/generic/tests/dockercli` own that half.
`suites/cli/cases/global/g6-…` and `g7-…` cover what does not need an
image at all — the binary answers identically however it was reached, and
answers with the name that still exists.

### `registry`

Pull the digest-pinned image from `ghcr.io/retnd/retnd`,
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
`retnd`'s own gate, where the build under test is the commit
being made and a pin would be pointing at the wrong thing.

```sh
RETND_MODE=local \
RETND_BINARY=/path/to/product-checkout/core/retnd \
RETND_SOURCE_DIR=/path/to/product-checkout \
make suite-a
```

`local` mode refuses to run unless it is told which commit the binary
claims to be, through `RETND_COMMIT` or by reading `HEAD` from
`RETND_SOURCE_DIR`. That refusal is the point: an unverifiable build is
exactly the condition that lets a suite report green against something
nobody meant to test.

## The identity handshake

Before a single case runs, in every mode, the harness invokes
`retnd version` and compares the commit it prints against what the pin
promised. It reads the first line under every name the command has ever
had — `retnd`, `backupd`, `rbm`, `backup-manager` — so a pin pointing
back at a build from before any of the three renames can still say which
commit it is; the printed name itself is asserted where an assertion
belongs, in `suites/cli/cases/version/happy.yaml`. A mismatch aborts the
run.

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
| `RETND_MODE` | force a mode, ignoring the pin's own |
| `RETND_BINARY` | `local`: the `retnd` binary to test |
| `RETND_WEB_BINARY` | `local`: the `retnd-web` binary, optional |
| `RETND_COMMIT` | `local`: the commit that binary claims to be |
| `RETND_SOURCE_DIR` | `local`: a checkout to read `HEAD` from when `RETND_COMMIT` is unset |
| `RETND_SOURCE_REPO` | `source`: clone from here instead of GitHub; a local checkout path works and is much faster |
| `RETND_CACHE_DIR` | where `source` mode keeps checkouts and built binaries |
| `RETND_TAGS` | run only the cases carrying one of these tags, for example `smoke` |
| `RETND_KEEP_WORK` | keep each case's fixture work directory for inspection |

## Moving to a newer build

Edit `commit` and `version` in `build-under-test.json`, run `make gate`,
and read what breaks. A case that starts failing is either a regression
in the product or a contract this suite had wrong, and the two are told
apart by going back to the document the case's `contract:` list names.

A case marked `known_discrepancy` that starts *passing* also fails, on
purpose. That is a fixed discrepancy asking to have its marker and its
`findings/` entry removed.
