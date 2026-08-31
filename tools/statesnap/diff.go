package statesnap

import (
	"fmt"
	"sort"
	"strings"
)

// maxDiffLines caps a rendered diff. A `catalog rebuild` that goes wrong
// can differ in thousands of rows, and a failure nobody reads is a
// failure nobody acts on; the count of what was elided is printed so the
// cap never hides the scale of the difference.
const maxDiffLines = 40

// Diff describes how snapshot b differs from snapshot a.
type Diff struct {
	Added    []string
	Removed  []string
	Changed  []string
	DBEvents []string
}

// Empty reports whether nothing changed at all.
func (d Diff) Empty() bool {
	return len(d.Added) == 0 && len(d.Removed) == 0 && len(d.Changed) == 0 && len(d.DBEvents) == 0
}

// Compare diffs two snapshots.
func Compare(a, b Snapshot) Diff {
	var d Diff
	for path, before := range a.Files {
		after, ok := b.Files[path]
		if !ok {
			d.Removed = append(d.Removed, path)
			continue
		}
		if before.SHA != after.SHA || before.Size != after.Size || before.Mode != after.Mode {
			d.Changed = append(d.Changed, fmt.Sprintf("%s (size %d -> %d, mode %s -> %s, sha256 %s -> %s)",
				path, before.Size, after.Size, before.Mode, after.Mode, short(before.SHA), short(after.SHA)))
		}
	}
	for path := range b.Files {
		if _, ok := a.Files[path]; !ok {
			d.Added = append(d.Added, path)
		}
	}
	sort.Strings(d.Added)
	sort.Strings(d.Removed)
	sort.Strings(d.Changed)
	d.DBEvents = compareDB(a.DB, b.DB)
	return d
}

func compareDB(a, b DB) []string {
	var out []string
	switch {
	case !a.Present && !b.Present:
		return nil
	case !a.Present && b.Present:
		out = append(out, fmt.Sprintf("state database created (%d table(s))", len(b.Tables)))
	case a.Present && !b.Present:
		out = append(out, "state database removed")
		return out
	}
	if a.Error != b.Error {
		out = append(out, fmt.Sprintf("state database readability changed: %q -> %q", a.Error, b.Error))
	}

	names := map[string]bool{}
	for t := range a.Tables {
		names[t] = true
	}
	for t := range b.Tables {
		names[t] = true
	}
	var sorted []string
	for t := range names {
		sorted = append(sorted, t)
	}
	sort.Strings(sorted)

	for _, t := range sorted {
		before, hadBefore := a.Tables[t]
		after, hadAfter := b.Tables[t]
		switch {
		case !hadBefore:
			out = append(out, fmt.Sprintf("table %s added (%d row(s))", t, len(after)))
			out = append(out, indent(rowsAdded(nil, after))...)
		case !hadAfter:
			out = append(out, fmt.Sprintf("table %s removed (%d row(s))", t, len(before)))
		default:
			added, removed := rowDelta(before, after)
			if len(added) == 0 && len(removed) == 0 {
				continue
			}
			out = append(out, fmt.Sprintf("table %s: +%d row(s), -%d row(s)", t, len(added), len(removed)))
			for _, r := range removed {
				out = append(out, "    - "+r)
			}
			for _, r := range added {
				out = append(out, "    + "+r)
			}
		}
	}
	return out
}

func rowsAdded(_ []string, after []string) []string {
	out := make([]string, 0, len(after))
	for _, r := range after {
		out = append(out, "+ "+r)
	}
	return out
}

func indent(lines []string) []string {
	out := make([]string, 0, len(lines))
	for _, l := range lines {
		out = append(out, "    "+l)
	}
	return out
}

// rowDelta compares two sorted row renderings as multisets, so a row that
// appears twice before and once after reads as one removal rather than as
// no change.
func rowDelta(before, after []string) (added, removed []string) {
	count := map[string]int{}
	for _, r := range before {
		count[r]++
	}
	for _, r := range after {
		if count[r] > 0 {
			count[r]--
			continue
		}
		added = append(added, r)
	}
	var keys []string
	for r, n := range count {
		for i := 0; i < n; i++ {
			keys = append(keys, r)
		}
	}
	sort.Strings(keys)
	sort.Strings(added)
	return added, keys
}

// String renders a diff for a failure message: minimal, ordered, capped.
func (d Diff) String() string {
	if d.Empty() {
		return "(no change)"
	}
	var lines []string
	for _, p := range d.Added {
		lines = append(lines, "+ "+p)
	}
	for _, p := range d.Removed {
		lines = append(lines, "- "+p)
	}
	for _, p := range d.Changed {
		lines = append(lines, "~ "+p)
	}
	lines = append(lines, d.DBEvents...)

	if len(lines) > maxDiffLines {
		elided := len(lines) - maxDiffLines
		lines = append(lines[:maxDiffLines], fmt.Sprintf("... and %d more difference(s)", elided))
	}
	return strings.Join(lines, "\n")
}

func short(sha string) string {
	if len(sha) <= 12 {
		return sha
	}
	return sha[:12]
}
