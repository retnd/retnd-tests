# DISC-009: a newly created retention tier does not always start on the default destination

- **Filed as**: [backupdproject/backupd#634](https://github.com/backupdproject/backupd/issues/634)
- **Pinned by**: nothing yet, deliberately. See "What the suite does about
  it" below; `suites/web-ui/e2e/storage-destinations.spec.ts`'s "gives a
  newly added tier a destination of its own, named rather than left empty"
  carries the argument in its own comment.
- **Build**: observed on `backupd` at `939da2f9`, the head of
  `fix/622-storage-destinations`. The feature is that branch's, so this
  cannot be older than it.
- **Kind**: a divergence between what the issue says the default governs
  and what the two editors that create tiers actually do with it.

## Contract

backupdproject/backupd#622, on what "default" means:

> "Default" is new. It is not currently in the model, and it needs to say
> what it governs: the destination a newly created tier starts on.

And the acceptance line:

> every retention tier, in both editors, offers a destination picker
> defaulting to the local hard drive, and can create a destination inline

Both editors. `RetentionPolicyCard` (the deployment's own policy, on the
settings page) and `BackupSetRetentionCard` (a backup set's custom
retention policy) are the two.

## Observed

Two different ways a new tier can start somewhere other than the default,
and only one of them is about staleness.

**The settings page's two cards do not tell each other.**
`StorageDestinationsCard` holds its own `useAsync(listStorageMediums)` and
reloads it after "Make default". `RetentionPolicyCard` reads the default
out of `getSettings().mediums`, through `defaultDestinationId`, and holds
that in a separate `useAsync` nothing reloads. So on one page, in one
sitting: move the default to a bucket, watch the badge move, click "Add
tier", and the new tier starts on whatever was the default when the page
loaded.

**The per-set editor never asks.** `RetentionPolicyCard`'s "Add tier" was
changed to seed the draft:

```tsx
toDraft({ name: "", granularity: "day", keep: 1, medium: defaultDestinationId(mediums) })
```

`BackupSetRetentionCard`'s was not, and still reads:

```tsx
toDraft({ name: "", granularity: schema.granularities[0] ?? "day", keep: 1 })
```

`toDraft` fills an absent medium with the local id, so a tier added to a
backup set's own policy starts on the drive whatever the deployment marked
default. That file is not in `fix/622-storage-destinations`'s diff at all;
it gets the picker for free because `TierRow` now renders one
unconditionally, and it gets no share of the default.

## What it costs

Less than the shape suggests, and it is worth being precise rather than
alarming. Nothing moves and nothing is deleted: this is where a NEW tier
starts, and the operator is looking straight at the picker that says so,
with the FR-27 disclosure still standing in front of any save that sends
a tier off the machine. What it costs is the setting doing what it says
on the surface where an operator would most reasonably try it, which is
the surface they were just on.

## What the suite does about it

Nothing that asserts either behaviour, and that is a decision rather than
an omission.

The correct behaviour cannot be pinned here: Suite B is mock-backed, the
mock lives in the page, and a reload builds a fresh one with the default
back on the drive, so there is no way to get a browser into "the default
is a bucket" and then create a tier. Suite B has no expected-failure
marker either, and adding one for this would be adding a mechanism to
record a single finding.

Asserting the observed behaviour is worse and is the thing this
repository exists to refuse: a case saying "a new tier starts on local"
passes today, passes on the fix, and pins nothing either way.

So what is pinned is the part that holds under both readings and that the
pinned build gets wrong: a newly added tier NAMES a destination, by id,
at the moment it appears, where before backupd#622 its draft
carried `""` and the picker rendered blank. The rest is written down
here, and the case's own comment says so where somebody reading it will
be wondering.
