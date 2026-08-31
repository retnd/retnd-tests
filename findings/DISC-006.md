# DISC-006: FR-18 does not say which timestamp puts an artifact in a retention bucket

- **Filed as**: [spdrman/rclone-manager#192](https://github.com/spdrman/rclone-manager/issues/192)
- **Pinned by**: `suites/cli/cases/retention/every-artifact-is-kept-or-deleted.yaml`
- **Build**: `rclone-manager` at `8ad310014b5be92e75789c8cff4167942d0c8e42`
- **Kind**: open contract question, not a divergence. There is no
  `known_discrepancy` marker for it, because there is no documented
  behaviour for the product to be diverging from.

## Contract

FR-18 defines an ordered chain of tiers, each bucketing artifacts into
calendar buckets anchored to a day, a week-start weekday, the first of
the month and so on, and each independently selecting "the newest valid
backup in each of its own buckets". KEEP is the union of those selections
plus FR-19's protected term; DELETE is everything managed and complete
that the union did not claim.

Nowhere does it say **which timestamp** decides an artifact's bucket: the
backup's own date, or the moment this manager received it.

## Observed

Six artifacts whose remote mtimes span 500 days, all ingested by one
`fetch`:

```
production/postgres-primary:
  DELETE pg-age-000d.dump                         tiers=[]
  DELETE pg-age-003d.dump                         tiers=[]
  DELETE pg-age-020d.dump                         tiers=[]
  DELETE pg-age-050d.dump                         tiers=[]
  DELETE pg-age-200d.dump                         tiers=[]
  KEEP   pg-age-500d.dump                         tiers=[DAILY WEEKLY MONTHLY LAST_KNOWN_GOOD]
  last-known-good: artifact "pg-age-500d.dump" is the newest eligible restore point in this backup set and holds FR-19 last-known-good protection
```

Consistent with bucketing by a catalog timestamp: all six were committed
within milliseconds, so they occupy one day, one week and one month
bucket, each tier picks one representative, and the union is a single
artifact. Not consistent with remote mtime, where the two youngest would
be in different day buckets and both kept, nor with local mtime, where
the survivor would be the youngest rather than the oldest.

## Why it is a question and not a finding

Both readings are defensible, and the current one has a real argument
behind it: FR-8 says remote filenames and metadata SHALL be treated as
untrusted input, and remote mtime is exactly that, so a producer with a
wrong clock could otherwise reshape retention. FR-18 also requires
retention to be deterministic, and ingest time is under this manager's
control.

So there is nothing here to mark as expected-to-fail. What there is, is a
hazard worth settling before FR-20 deletion lands (#21): every situation
that ingests a backlog in one cycle produces this pattern, including a
new backup set pointed at an existing archive, a manager catching up
after an outage, and a NAS restored and re-reconciled. In each of those
the backups have genuinely different dates, and under the current reading
FR-19 saves exactly one of them.

## What the suite does about it

`retention/every-artifact-is-kept-or-deleted` asserts only what holds
under either reading: every managed artifact is itemised exactly once
with a verdict, and the artifact carrying FR-19 protection is on the KEEP
side. It does not pin which artifacts land where, so it does not have to
be rewritten whichever way the question is answered.

The consequence for coverage is listed in `suites/cli/COVERAGE.md`: under
the current behaviour a single-cycle fixture cannot produce a multi-tier
GFS shape at all, so tier windows, `week_starts_on` and timezone handling
have no black-box coverage yet, and the override cases prove the flags
are accepted and inert against config rather than that they change the
itemisation.
