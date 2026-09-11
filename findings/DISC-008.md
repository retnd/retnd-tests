# DISC-008: the mock API's candidate test connection has its verdict inverted, so no destination can be saved in the browser

- **Filed as**: [spdrman/backupd#633](https://github.com/spdrman/backupd/issues/633)
- **Pinned by**: `suites/web-ui/e2e/storage-destinations.spec.ts`, "opens a
  destination wizard inside the tier, and tests the candidate from there",
  which drives everything up to the inverted step and stops there
- **Build**: observed on `backupd` at
  `87a9dc72dab2eb3161072b738bd29b0ccfb3b811`, which is the pin, and
  unchanged on `fix/622-storage-destinations`. It predates both.
- **Kind**: a fixture defect that inverts a safety answer, found by driving
  a path nothing had driven before.

## Contract

`ui/shared/src/api/mock.ts`'s own comment on `mockPreflightFor`:

> The archive case is not decoration. A destination whose class cannot
> take delivery fails at `deliverable` and skips the five steps after it,
> and a form built against an always-green fixture never renders the one
> answer an operator has to act on.

An archive class is `GLACIER` or `DEEP_ARCHIVE`. `STANDARD` and
`STANDARD_IA` read on demand and can take delivery, which is what
`config.Validate` enforces one layer down: backupd#442 refuses a
retention tier bound to an archive class outright, because the move can
never reach VERIFIED.

## Observed

`mockPreflightFor(medium, deliverable)` takes `deliverable` as its second
parameter. The by-id check passes it correctly:

```ts
preflightStorageMedium: (mediumId) => { ...
  return delay(mockPreflightFor(medium, !medium.readsRequireRestore), 700);
}
```

The candidate check passes the opposite:

```ts
preflightStorageMediumCandidate: (spec) => {
  const archive = spec.storageClass === "GLACIER" || spec.storageClass === "DEEP_ARCHIVE";
  return delay(mockPreflightFor({ ... }, archive), 700);
}
```

So a STANDARD-class candidate is reported as

```
deliverable  failed(configuration)  storage class STANDARD holds objects
that cannot be read until an explicit restore has finished, so a
retention tier cannot deliver to this medium
```

and the five steps after it are skipped, while a DEEP_ARCHIVE candidate
would be waved through.

## What it costs

`S3DestinationWizard` gates Save on `report !== null && report.ok`, so in
the browser:

- an ordinary destination can never be saved, in the destinations card or
  from inside a retention tier;
- the one class that a retention tier is refused for is the one the
  wizard would let through.

The second half is the reason this is not merely a dev-fixture annoyance.
The wizard's verify-before-save gate is the surface that teaches an
operator which storage classes work, and on this fixture it teaches the
opposite.

## Why nothing caught it

Suite B never drove the wizard past step 2 before
`storage-destinations.spec.ts`, and the product's own
`s3-destination-wizard.test.tsx` renders the component against a stub of
its own rather than against `createMockApi`, so the mock's projection of
a spec is not on any path either test takes. The by-id check, which is
correct, is the one both of them exercise.

## What the suite does about it

Nothing that depends on the bug. The case named above drives the wizard
open from inside a retention tier, fills it, runs the candidate check and
asserts that the check is reachable from there, reports every step, and
carries the `medium test-connection --candidate` line under it. It stops
before Save.

Driving Save by declaring `DEEP_ARCHIVE` would work today and is exactly
what must not be written: it would be a case that only passes while the
bug is there, and it would go red on the fix. So the "a destination
created under a tier is selected by that tier" half of
backupd#622 has no browser coverage until this is closed, and
saying so here is the whole point of this file.
