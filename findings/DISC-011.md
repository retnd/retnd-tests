# DISC-011: a refused `backup-set create` strands the SSH key it imported

- **Filed as**: to be opened against `backupdproject/backupd` (see "Filing")
- **Pinned by**: `suites/cli/cases/backup-set/create-refuses-kopia-without-a-repository-domain.yaml`
  (the `state` dimension only)
- **Build**: observed on `backupd` at
  `4ffc25fb1b8980a85fccc1cb6d9795f23b297569`
- **Kind**: credential material written by an operation that was refused,
  under the name of a backup set that does not exist.

## Contract

`backup-set create` is documented as writing the configuration only when
the create succeeds:

> The connection is proven before anything is written, and the create is
> refused when it cannot be

and, for the routed case,

> With something serving and no route, the write is refused and nothing is
> written

FR-33's rule for credential material is that it is "stored once, in a file
only this service can read". Nothing in the documentation describes a
credential written for a set that was never created.

## Observed

Three `backup-set create` invocations against one fixture -- one that
succeeded, and two refused by configuration validation (`--engine kopia`
with no `--repository-domain`, and an unusable engine value) -- left:

```
$ ls -1 ${WORK}/ssh_keys | wc -l
3
$ ls -1 ${WORK}/known_hosts.d
production_api-uploads_known_hosts
production_nodomain_known_hosts
$ grep -c 'nodomain\|badengine' ${WORK}/config.yaml
0
```

So each refused create imported its key and wrote a `known_hosts` file,
and the configuration names none of them. The stranded files are
referenced by nothing, listed by nothing (`sources` reads the
configuration), and cleaned up by nothing.

The order is visible in the output of the refused run: `imported
ssh-ed25519 key SHA256:...` is printed, and the unverified-connection
paragraph with it, BEFORE the refusal.

## Why this matters

Three reasons, in increasing order:

1. It is litter with an operator's name on it. A fleet script that
   iterates `backup-set create` over a list and hits a bad line leaves
   one key file per failure, indistinguishable from live ones.
2. It is credential material outliving the intent to use it, which is the
   thing FR-33's custody rules exist to bound. A key nobody can see in
   `sources` is a key nobody will ever revoke.
3. The two writes are not symmetrical with the configuration write, so
   the create is not atomic in the way its own documentation describes.
   That is a property somebody will eventually rely on.

## Suggested shape of a fix

Validate before importing. The configuration the create would write is
already assembled and validated -- that is what produces this refusal --
so the key import and the `known_hosts` write can happen after that
validation passes rather than before it. Failing that, roll both back on
every refusal path, which is the weaker fix because it has to be
remembered at each one.

## Scope of the marker

`known_discrepancy_dimensions: [state]`. The exit code (1), the empty
stdout and the refusal text are all correct and stay asserted strictly, so
a regression in any of them fails the case for real.

## Filing

Produced by the #789 release-gate work. It belongs upstream as its own
issue against `core/cmd/backupd/backupset.go` and the service-layer create
path.
