package fixtures

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestParseOffsetRejectsWhatItCannotExpress matters because a typo in an
// mtime that silently parsed as "now" would quietly turn a staleness
// fixture into a freshness fixture, and the case built on it would still
// pass, just not for the reason anybody thought.
func TestParseOffsetRejectsWhatItCannotExpress(t *testing.T) {
	now := time.Date(2026, 6, 1, 12, 0, 0, 0, time.UTC)
	good := map[string]time.Duration{
		"":        0,
		"now":     0,
		"now-45m": 45 * time.Minute,
		"now-2h":  2 * time.Hour,
		"now-90d": 90 * 24 * time.Hour,
	}
	for spec, back := range good {
		got, err := parseOffset(spec, now)
		if err != nil {
			t.Errorf("parseOffset(%q): %v", spec, err)
			continue
		}
		if want := now.Add(-back); !got.Equal(want) {
			t.Errorf("parseOffset(%q) = %s, want %s", spec, got, want)
		}
	}
	for _, spec := range []string{"yesterday", "now+1h", "now-", "now-3s", "now-xd", "now--1d", "-1d"} {
		if _, err := parseOffset(spec, now); err == nil {
			t.Errorf("parseOffset(%q) should have been refused, and was not", spec)
		}
	}
}

// TestArtifactBytesAreDeterministic is what lets a case assert a digest
// at all. Two materialisations of the same scenario have to produce the
// same bytes on any machine.
func TestArtifactBytesAreDeterministic(t *testing.T) {
	scn := Scenario{
		Name: "determinism",
		Sources: []Source{{ID: "production", BackupSets: []BackupSet{{
			ID:         "postgres-primary",
			Remote:     Remote{Type: "local"},
			Include:    []string{"*.dump"},
			Completion: Completion{Strategy: "rename"},
			StaleAfter: "30h",
			Artifacts:  []Artifact{{Name: "a.dump", Size: 1024, Seed: "seed-1"}},
		}}}},
		State: "none",
	}

	first := materialize(t, scn)
	second := materialize(t, scn)

	a := read(t, filepath.Join(first.Sets[0].RemotePath, "a.dump"))
	b := read(t, filepath.Join(second.Sets[0].RemotePath, "a.dump"))
	if string(a) != string(b) {
		t.Fatal("two materialisations of the same scenario produced different artifact bytes, so no digest assertion built on them means anything")
	}
	if len(a) != 1024 {
		t.Errorf("artifact size = %d, want 1024", len(a))
	}

	scn.Sources[0].BackupSets[0].Artifacts[0].Seed = "seed-2"
	c := read(t, filepath.Join(materialize(t, scn).Sets[0].RemotePath, "a.dump"))
	if string(a) == string(c) {
		t.Error("changing the seed produced identical bytes, so the seed is not reaching the generator")
	}
}

// TestReplayWithoutABinaryRefuses closes the failure mode where a
// scenario that meant to seed a catalog quietly produces an empty one.
func TestReplayWithoutABinaryRefuses(t *testing.T) {
	scn := Scenario{Name: "needs-replay", State: "replay", Replay: "fetch"}
	if _, err := Materialize(scn, Options{Work: t.TempDir()}); err == nil {
		t.Fatal("materialising a replay scenario with no binary should refuse, and did not")
	}
}

func TestCorruptStateIsNotASQLiteFile(t *testing.T) {
	scn := Scenario{Name: "corrupt", State: "corrupt", RawConfig: "# placeholder\n"}
	m, err := Materialize(scn, Options{Work: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	raw := read(t, m.StateDB)
	if string(raw[:15]) == "SQLite format 3" {
		t.Fatal("the corrupt-state fixture wrote something that starts like a real database")
	}
}

func materialize(t *testing.T, s Scenario) Manifest {
	t.Helper()
	m, err := Materialize(s, Options{Work: t.TempDir(), Now: time.Date(2026, 6, 1, 12, 0, 0, 0, time.UTC)})
	if err != nil {
		t.Fatalf("Materialize: %v", err)
	}
	return m
}

func read(t *testing.T, path string) []byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading %s: %v", path, err)
	}
	return b
}
