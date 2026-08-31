package statesnap

import (
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The state differ is the oracle every `state:` assertion in Suite A
// leans on, and it is the one piece of the harness whose failures the
// binary under test cannot corroborate. So it gets its own boundary
// tests: what it must notice, and what it must not.

func TestCompareNoticesNothingWhenNothingChanged(t *testing.T) {
	dir := t.TempDir()
	write(t, filepath.Join(dir, "a.txt"), "hello")

	before := take(t, dir, "")
	after := take(t, dir, "")
	if d := Compare(before, after); !d.Empty() {
		t.Fatalf("an unchanged directory produced a diff:\n%s", d)
	}
}

func TestCompareNoticesAddedRemovedAndEditedFiles(t *testing.T) {
	dir := t.TempDir()
	write(t, filepath.Join(dir, "kept.txt"), "kept")
	write(t, filepath.Join(dir, "removed.txt"), "gone soon")
	write(t, filepath.Join(dir, "edited.txt"), "before")
	before := take(t, dir, "")

	if err := os.Remove(filepath.Join(dir, "removed.txt")); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(dir, "edited.txt"), "after")
	write(t, filepath.Join(dir, "added.txt"), "new")
	after := take(t, dir, "")

	d := Compare(before, after)
	if d.Empty() {
		t.Fatal("three changes produced no diff at all")
	}
	rendered := d.String()
	for _, want := range []string{"+ added.txt", "- removed.txt", "~ edited.txt"} {
		if !strings.Contains(rendered, want) {
			t.Errorf("the diff does not mention %q:\n%s", want, rendered)
		}
	}
	if strings.Contains(rendered, "kept.txt") {
		t.Errorf("the diff mentions an unchanged file:\n%s", rendered)
	}
}

// TestCompareNoticesSameSizeEdit is the case a size-and-mtime comparison
// would miss, and the reason snapshots carry digests.
func TestCompareNoticesSameSizeEdit(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "same-size.bin")
	write(t, path, "aaaa")
	before := take(t, dir, "")
	write(t, path, "bbbb")

	if d := Compare(before, take(t, dir, "")); d.Empty() {
		t.Fatal("a same-size edit went unnoticed, so the snapshot is not comparing content")
	}
}

func TestSidecarsAreIgnored(t *testing.T) {
	dir := t.TempDir()
	db := filepath.Join(dir, "state.db")
	write(t, db, "")
	before := take(t, dir, db)

	// Exactly the files a process leaves beside the journal: SQLite's own
	// and the two advisory locks core/service/startup.go derives from the
	// database path.
	for _, suffix := range []string{"-wal", "-shm", ".startup-lock", ".journal-lock"} {
		write(t, db+suffix, "transient")
	}
	if d := Compare(before, take(t, dir, db)); !d.Empty() {
		t.Fatalf("a sidecar appearing beside the database was reported as a state change:\n%s", d)
	}
}

func TestDatabaseRowsAreComparedLogically(t *testing.T) {
	dir := t.TempDir()
	db := filepath.Join(dir, "state.db")

	conn, err := sql.Open("sqlite", "file:"+db)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(`CREATE TABLE artifacts (id TEXT PRIMARY KEY, state TEXT)`); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(`INSERT INTO artifacts VALUES ('a/b/c', 'COMMITTED')`); err != nil {
		t.Fatal(err)
	}
	before := take(t, dir, db)

	if _, err := conn.Exec(`UPDATE artifacts SET state = 'COMPLETE' WHERE id = 'a/b/c'`); err != nil {
		t.Fatal(err)
	}
	after := take(t, dir, db)
	if err := conn.Close(); err != nil {
		t.Fatal(err)
	}

	d := Compare(before, after)
	if d.Empty() {
		t.Fatal("a lifecycle state change in the journal produced no diff")
	}
	rendered := d.String()
	for _, want := range []string{"table artifacts", "COMMITTED", "COMPLETE"} {
		if !strings.Contains(rendered, want) {
			t.Errorf("the diff does not mention %q, so it is not readable enough to act on:\n%s", want, rendered)
		}
	}
}

func TestDatabaseCreationIsReported(t *testing.T) {
	dir := t.TempDir()
	db := filepath.Join(dir, "state.db")
	before := take(t, dir, db)
	if before.DB.Present {
		t.Fatal("a database that does not exist was reported as present")
	}

	conn, err := sql.Open("sqlite", "file:"+db)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(`CREATE TABLE t (x INTEGER)`); err != nil {
		t.Fatal(err)
	}
	if err := conn.Close(); err != nil {
		t.Fatal(err)
	}

	d := Compare(before, take(t, dir, db))
	if !strings.Contains(d.String(), "state database created") {
		t.Fatalf("creating the database was not reported:\n%s", d)
	}
}

// TestCorruptDatabaseSnapshotsRatherThanExploding matters because the
// corrupt-state fixture exists precisely to be unreadable, and a snapshot
// that returned an error there would make that whole family of cases
// impossible to assert on-disk state for.
func TestCorruptDatabaseSnapshotsRatherThanExploding(t *testing.T) {
	dir := t.TempDir()
	db := filepath.Join(dir, "state.db")
	write(t, db, "NOT-A-SQLITE-DB and never will be")

	snap := take(t, dir, db)
	if !snap.DB.Present {
		t.Error("a corrupt database file is still present, and the snapshot should say so")
	}
	if snap.DB.Error == "" {
		t.Error("a corrupt database should record why it could not be read")
	}
}

func TestDiffIsCappedButSaysSo(t *testing.T) {
	dir := t.TempDir()
	before := take(t, dir, "")
	for i := 0; i < maxDiffLines+10; i++ {
		write(t, filepath.Join(dir, string(rune('a'+i%26))+strings.Repeat("x", i)), "content")
	}
	rendered := Compare(before, take(t, dir, "")).String()
	if !strings.Contains(rendered, "more difference(s)") {
		t.Errorf("a diff longer than the cap should say how much it elided:\n%s", rendered)
	}
	if lines := strings.Count(rendered, "\n") + 1; lines > maxDiffLines+1 {
		t.Errorf("the diff was not capped: %d lines", lines)
	}
}

func write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func take(t *testing.T, root, db string) Snapshot {
	t.Helper()
	snap, err := Take(root, db)
	if err != nil {
		t.Fatalf("Take(%s): %v", root, err)
	}
	return snap
}
