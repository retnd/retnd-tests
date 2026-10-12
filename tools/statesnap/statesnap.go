// Package statesnap answers "did this command change anything on disk",
// which is the fourth assertion dimension every CLI case carries and the
// only one the binary's own output cannot be asked about.
//
// A snapshot is two halves, because a work directory has two kinds of
// content in it:
//
//   - Ordinary files are compared byte for byte, by digest.
//   - The FR-9 state database is compared logically, table by table and
//     row by row, because SQLite legitimately rewrites parts of a file
//     (page reuse, freelist bookkeeping, the WAL) without any row
//     changing. Byte-comparing it would make "state: unchanged" fail on
//     read-only commands, and the first person to hit that would delete
//     the assertion rather than the false positive.
//
// One table is the exception to "every table counts": AdditiveTables names
// activity_events, the durable activity feed, whose appended rows
// CompareAllowingAdditive does not report (Suite A's runner uses it). The
// allowlist is by table name only, growth only, and carries its reason; see
// diff.go.
//
// The logical dump is schema-blind: it reads sqlite_master to find out
// what tables exist and dumps whatever columns it finds. That is the one
// place this repository touches FR-9's internals at all, and it touches
// them without knowing a single table or column name, so a schema
// migration changes what a diff prints and never breaks the tool itself.
// Where a product read command exposes the same fact (`artifacts`,
// `status`, `sources`), a case should assert against that instead: the
// product's own read surface is the better oracle, and this is for the
// facts it does not expose.
package statesnap

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	_ "modernc.org/sqlite"
)

// Snapshot is a normalised view of a work directory at one instant.
type Snapshot struct {
	Root  string          `json:"root"`
	Files map[string]File `json:"files"`
	DB    DB              `json:"db"`
}

type File struct {
	Size int64  `json:"size"`
	Mode string `json:"mode"`
	SHA  string `json:"sha256"`
}

type DB struct {
	Path    string `json:"path"`
	Present bool   `json:"present"`
	// Tables maps a table name to its rows, each row rendered as one
	// string and the set sorted, so two dumps of the same content compare
	// equal regardless of the order SQLite happened to hand rows back in.
	Tables map[string][]string `json:"tables"`
	// Error records why a present database could not be read. It is kept
	// rather than returned so a corrupt-database fixture still snapshots,
	// and so a diff can say "it stopped being readable" out loud.
	Error string `json:"error,omitempty"`
}

// sidecars are the files that live beside a state database and belong to
// a process's lifetime rather than to the backup estate's state: SQLite's
// own write-ahead log and shared-memory files, and the two advisory lock
// files core/service/startup.go derives from the journal path
// (.startup-lock and .journal-lock). They are excluded from the file half
// of a snapshot because whether one exists depends on which command last
// held the journal open and whether it tidied up after itself, which is
// not a fact about anybody's backups.
//
// Excluding them is a real, deliberate loss of coverage: a leaked lock
// file will not fail a `state: unchanged` case. That is the right trade
// here, because the alternative is every dry-run and read-only case
// failing for a reason none of them is about, and the first person under
// deadline pressure deleting the state assertion instead of the noise.
var sidecars = []string{"-wal", "-shm", "-journal", ".startup-lock", ".journal-lock"}

// Take snapshots root, treating dbPath (which may be empty, or point
// somewhere outside root) as the state database.
func Take(root, dbPath string) (Snapshot, error) {
	snap := Snapshot{Root: root, Files: map[string]File{}}
	if resolved, err := filepath.EvalSymlinks(root); err == nil {
		snap.Root = resolved
		root = resolved
	}
	if dbPath != "" {
		if resolved, err := filepath.EvalSymlinks(filepath.Dir(dbPath)); err == nil {
			dbPath = filepath.Join(resolved, filepath.Base(dbPath))
		}
	}

	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		if dbPath != "" {
			if path == dbPath {
				return nil
			}
			for _, suffix := range sidecars {
				if path == dbPath+suffix {
					return nil
				}
			}
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		sum, err := digest(path)
		if err != nil {
			return err
		}
		snap.Files[filepath.ToSlash(rel)] = File{Size: info.Size(), Mode: info.Mode().Perm().String(), SHA: sum}
		return nil
	})
	if err != nil {
		return snap, err
	}

	snap.DB = dumpDB(dbPath)
	return snap, nil
}

func digest(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer func() { _ = f.Close() }()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func dumpDB(path string) DB {
	d := DB{Path: path, Tables: map[string][]string{}}
	if path == "" {
		return d
	}
	if _, err := os.Stat(path); err != nil {
		return d
	}
	d.Present = true

	conn, err := sql.Open("sqlite", "file:"+path+"?mode=ro")
	if err != nil {
		d.Error = err.Error()
		return d
	}
	defer func() { _ = conn.Close() }()

	rows, err := conn.Query(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
	if err != nil {
		d.Error = err.Error()
		return d
	}
	var tables []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			d.Error = err.Error()
			_ = rows.Close()
			return d
		}
		tables = append(tables, name)
	}
	if err := rows.Err(); err != nil {
		d.Error = err.Error()
	}
	_ = rows.Close()

	for _, t := range tables {
		dumped, err := dumpTable(conn, t)
		if err != nil {
			d.Error = fmt.Sprintf("table %s: %v", t, err)
			return d
		}
		d.Tables[t] = dumped
	}
	return d
}

func dumpTable(conn *sql.DB, table string) ([]string, error) {
	// The table name comes from sqlite_master, not from user input, and
	// SQLite has no placeholder syntax for identifiers. Quoting it is what
	// keeps a table called "order" or "group" working.
	rows, err := conn.Query(`SELECT * FROM "` + strings.ReplaceAll(table, `"`, `""`) + `"`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	cols, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	var out []string
	for rows.Next() {
		cells := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range cells {
			ptrs[i] = &cells[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return nil, err
		}
		var b strings.Builder
		for i, c := range cols {
			if i > 0 {
				b.WriteString(" ")
			}
			fmt.Fprintf(&b, "%s=%s", c, render(cells[i]))
		}
		out = append(out, b.String())
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	sort.Strings(out)
	return out, nil
}

func render(v any) string {
	switch x := v.(type) {
	case nil:
		return "<null>"
	case []byte:
		if isPrintable(x) {
			return fmt.Sprintf("%q", string(x))
		}
		return "blob:sha256:" + hex.EncodeToString(sha256sum(x))
	case string:
		return fmt.Sprintf("%q", x)
	default:
		return fmt.Sprintf("%v", x)
	}
}

func sha256sum(b []byte) []byte {
	sum := sha256.Sum256(b)
	return sum[:]
}

func isPrintable(b []byte) bool {
	if len(b) > 512 {
		return false
	}
	for _, c := range b {
		if c < 0x20 && c != '\t' && c != '\n' && c != '\r' {
			return false
		}
	}
	return true
}
