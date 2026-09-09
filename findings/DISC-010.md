# DISC-010: a backup's detail page is unreachable, because an artifact id is three URL segments and its route is one

- **Filed as**: `spdrman/rclone-manager` (to be filed; see "Filing" below)
- **Pinned by**: `suites/web-ui/e2e/backups.spec.ts`, the cases marked
  `test.fail()` with this finding's number on them
- **Build**: observed on `rclone-manager` at
  `3fb56f36002d0e23c2f646abeaf3a55e1dce6b35`, through the three-machine
  rig in that repository's `scripts/e2e/`
- **Kind**: a defect the product already found and fixed once, on a
  neighbouring route, left standing on this one. Invisible to every test
  that existed, for a reason worth reading.

## Contract

`core/internal/model/ids.go`:

```go
func (a ArtifactID) String() string { return a.Set.String() + separator + a.Name }
```

A `BackupSetID` is itself `source + "/" + set`, so an artifact id is
**three** slash-separated segments: `e2e/vps/notes.txt`.

`ui/shared/src/App.tsx` declares:

```tsx
<Route path="/backups/:artifactId" element={<BackupDetailPage />} />
```

One segment. The same file gets this right for backup sets, four lines
above, with a comment that states the rule in as many words:

```tsx
{/* Two segments, not one: a real backup set id (model.BackupSetID.
    String(), core/internal/model/ids.go) is source and set
    joined by "/", matching the API's own /backup-sets/{source}/
    {set}/... shape (router.go). A single :setId segment cannot
    match a path with that extra segment in it (issue #285). */}
<Route path="/sets/:source/:set" element={<BackupSetDetailPage readOnly={readOnly} />} />
```

Issue #285 is that same defect, on that route, already fixed. Artifacts
have one more segment than backup sets and no such fix.

## Observed

`ui/shared/src/pages/BackupsPage.tsx` navigates on a row click with:

```tsx
onClick={() => navigate("/backups/" + a.id)}
```

No `encodeURIComponent`, so with a real id the browser is sent to
`/backups/e2e/vps/notes.txt`. That matches no route, App.tsx's catch-all
takes it, and **the operator lands on the Dashboard**.

Not an error, not a "backup not found", not a blank page. A click on a
backup silently navigates somewhere else entirely, and the only way to
tell it went wrong is to notice that the page you are on is the one you
started from.

The page snapshot from the failing run, after clicking the first row of a
table holding three real backups:

```yaml
- heading "Dashboard" [level=1]
```

Everything a backup's detail page carries is therefore unreachable in a
browser on a real deployment: the artifact fields, the lifecycle timeline
that proves remote deletion never precedes commit (§15), and the whole
Copies card that FR-34 is about.

## Why nothing caught it

This is the interesting half, and it is why this finding exists in this
repository rather than only as a bug report.

`suites/web-ui` drove `createMockApi` through a Vite dev server until the
change that found this. The mock's artifacts carry ids like
`art_01J9C1XY7T09`: one segment, no slashes. So `"/backups/" + a.id`
produced a URL that matched the route perfectly, the detail page rendered,
and five cases in `backups.spec.ts` asserted their way happily through a
page no operator could reach.

The fixture was not wrong about anything else. It was wrong about the
SHAPE of an identifier, which is exactly the kind of thing a fixture is
written without thinking about, and exactly the kind of thing that decides
whether a route matches.

The very first run of this suite against a real deployment found it.

## Filing

To be filed against `spdrman/rclone-manager`. The fix has a precedent in
the same file: either declare the route with the segments the id really
has (`/backups/:source/:set/:name`, matching what #285 did for sets), or
encode the id into one segment at the call site and decode it in
`BackupDetailPage`. The first matches the API's own
`/backups/{id}` shape and the neighbouring route's treatment; the second
is smaller. Whoever fixes it should also check `getArtifact`, which
passes the same id straight into a URL path.

## The marker

The cases are `test.fail()` rather than skipped or loosened, which is this
repository's strict expected-failure shape (`findings/README.md`): while
the defect stands they are red and that is the expected outcome, so the
suite stays green; the moment somebody fixes the route they go red on
purpose, because a marker for a fixed discrepancy is a lie. Removing the
marker and this file is part of the fix.
