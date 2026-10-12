package statesnap

import (
	"database/sql"
	"path/filepath"
	"strings"
	"testing"
)

// The activity feed (retnd#1071) writes a row to activity_events for every
// log line a process files, so a command that opens the write door leaves
// rows behind even when it refused and did no work. Those rows are an
// append-only record, not backup state, and `state: unchanged` must not
// count them. What it must still count is anything else, and that is what
// these tests pin: the exclusion is the table's NAME, nothing wider.

func feedDB(t *testing.T) (dir, db string, conn *sql.DB) {
	t.Helper()
	dir = t.TempDir()
	db = filepath.Join(dir, "state.db")
	conn, err := sql.Open("sqlite", "file:"+db)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	for _, stmt := range []string{
		`CREATE TABLE activity_events (seq INTEGER PRIMARY KEY, event TEXT)`,
		`CREATE TABLE artifacts (id TEXT PRIMARY KEY, state TEXT)`,
		`INSERT INTO activity_events VALUES (1, 'startup')`,
		`INSERT INTO artifacts VALUES ('a/b/c', 'COMMITTED')`,
	} {
		if _, err := conn.Exec(stmt); err != nil {
			t.Fatal(err)
		}
	}
	return dir, db, conn
}

func exec(t *testing.T, conn *sql.DB, stmt string) {
	t.Helper()
	if _, err := conn.Exec(stmt); err != nil {
		t.Fatal(err)
	}
}

func TestAdditiveTablesNamesTheFeedAndGivesAReason(t *testing.T) {
	reason, ok := AdditiveTables["activity_events"]
	if !ok {
		t.Fatal("activity_events is not on the additive allowlist")
	}
	if len(strings.TrimSpace(reason)) < 40 {
		t.Errorf("an allowlist entry has to say why, in a sentence; got %q", reason)
	}
	if len(AdditiveTables) != 1 {
		t.Errorf("the allowlist is meant to be narrow, one table; it names %d: %v", len(AdditiveTables), AdditiveTables)
	}
}

func TestAppendedFeedRowsAreNotAStateChange(t *testing.T) {
	dir, db, conn := feedDB(t)
	before := take(t, dir, db)
	exec(t, conn, `INSERT INTO activity_events VALUES (2, 'startup'), (3, 'rclone_version')`)
	after := take(t, dir, db)

	if d := Compare(before, after); d.Empty() {
		t.Fatal("the plain Compare has to keep reporting every table, the allowlist is opt-in")
	}
	if d := CompareAllowingAdditive(before, after, AdditiveTables); !d.Empty() {
		t.Fatalf("rows appended to the feed were reported as a state change:\n%s", d)
	}
}

// The planted control: the same run also changes a table that is NOT on the
// allowlist. If the exclusion were wider than a name, this would go quiet.
func TestARealChangeBesideFeedRowsIsStillCaught(t *testing.T) {
	dir, db, conn := feedDB(t)
	before := take(t, dir, db)
	exec(t, conn, `INSERT INTO activity_events VALUES (2, 'startup')`)
	exec(t, conn, `UPDATE artifacts SET state = 'FAILED' WHERE id = 'a/b/c'`)
	after := take(t, dir, db)

	d := CompareAllowingAdditive(before, after, AdditiveTables)
	if d.Empty() {
		t.Fatal("an artifact moving to FAILED was forgiven because the feed also grew")
	}
	rendered := d.String()
	if !strings.Contains(rendered, "table artifacts") || strings.Contains(rendered, "activity_events") {
		t.Errorf("the diff should name artifacts and say nothing about the feed:\n%s", rendered)
	}
}

func TestAnInsertIntoAnotherTableIsStillCaught(t *testing.T) {
	dir, db, conn := feedDB(t)
	exec(t, conn, `CREATE TABLE settings (k TEXT PRIMARY KEY, v TEXT)`)
	before := take(t, dir, db)
	exec(t, conn, `INSERT INTO settings VALUES ('a', 'b')`)
	if d := CompareAllowingAdditive(before, take(t, dir, db), AdditiveTables); d.Empty() {
		t.Fatal("a row added to a table that is not on the allowlist was forgiven")
	}
}

// Additive means additive: a command that deletes or rewrites feed rows
// changed history, and that is a change.
func TestRemovingOrRewritingFeedRowsIsStillCaught(t *testing.T) {
	dir, db, conn := feedDB(t)
	before := take(t, dir, db)
	exec(t, conn, `UPDATE activity_events SET event = 'tampered' WHERE seq = 1`)
	if d := CompareAllowingAdditive(before, take(t, dir, db), AdditiveTables); d.Empty() {
		t.Fatal("rewriting a feed row was forgiven")
	}

	dir2, db2, conn2 := feedDB(t)
	before2 := take(t, dir2, db2)
	exec(t, conn2, `DELETE FROM activity_events`)
	if d := CompareAllowingAdditive(before2, take(t, dir2, db2), AdditiveTables); d.Empty() {
		t.Fatal("deleting feed rows was forgiven")
	}
}

// Files are not tables: the allowlist reaches nothing outside the database.
func TestAFileChangeBesideFeedRowsIsStillCaught(t *testing.T) {
	dir, db, conn := feedDB(t)
	before := take(t, dir, db)
	exec(t, conn, `INSERT INTO activity_events VALUES (2, 'startup')`)
	write(t, filepath.Join(dir, "activity_events"), "a file that happens to share the name")
	if d := CompareAllowingAdditive(before, take(t, dir, db), AdditiveTables); d.Empty() {
		t.Fatal("a new file was forgiven because its name matches a table")
	}
}

func TestAnEmptyAllowlistForgivesNothing(t *testing.T) {
	dir, db, conn := feedDB(t)
	before := take(t, dir, db)
	exec(t, conn, `INSERT INTO activity_events VALUES (2, 'startup')`)
	if d := CompareAllowingAdditive(before, take(t, dir, db), nil); d.Empty() {
		t.Fatal("with no allowlist, appended rows must be reported")
	}
}
