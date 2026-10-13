package fixtures

import (
	"bytes"
	"compress/gzip"
	"io"
	"os"
	"path/filepath"
	"strings"
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

// A recovery test names an operator's validator script, and that script has
// to exist on disk before the command runs. A scenario can say so with
// `files`, and add config the rendered shape has no field for with
// `extra_config`.
func TestScenarioFilesAreWrittenWithTheirModeAndTokens(t *testing.T) {
	scn := Scenario{
		Name: "files",
		Sources: []Source{{ID: "production", BackupSets: []BackupSet{{
			ID: "postgres-primary", Remote: Remote{Type: "local"}, Include: []string{"*.dump"},
			Completion: Completion{Strategy: "rename"}, StaleAfter: "30h",
			Artifacts: []Artifact{{Name: "a.dump", Size: 64, Seed: "s"}},
		}}}},
		State:       "none",
		ExtraConfig: "workflows:\n  root: ${WORK}/workflows\n",
		Files: []File{{
			Path: "workflows/recovery-test/production/postgres-primary/reads-nothing.local.sh", Mode: "0755",
			Content: "#!/bin/sh\ntouch ${WORK}/validator-ran\nexit 0\n",
		}},
	}
	m := materialize(t, scn)

	script := filepath.Join(m.Work, "workflows/recovery-test/production/postgres-primary/reads-nothing.local.sh")
	info, err := os.Stat(script)
	if err != nil {
		t.Fatalf("the scenario file was not written: %v", err)
	}
	if info.Mode().Perm() != 0o755 {
		t.Errorf("mode = %v, want 0755", info.Mode().Perm())
	}
	if got := string(read(t, script)); !strings.Contains(got, "touch "+m.Work+"/validator-ran") {
		t.Errorf("${WORK} was not expanded in the file content:\n%s", got)
	}
	cfg := string(read(t, m.Config))
	if !strings.Contains(cfg, "workflows:\n  root: "+m.Work+"/workflows\n") {
		t.Errorf("extra_config did not reach config.yaml with its tokens expanded:\n%s", cfg)
	}
	// The directories on the way to a script are what the product's custody
	// check reads, and a group- or world-writable one is refused.
	for dir := filepath.Dir(script); dir != m.Work; dir = filepath.Dir(dir) {
		di, err := os.Stat(dir)
		if err != nil {
			t.Fatal(err)
		}
		if di.Mode().Perm()&0o022 != 0 {
			t.Errorf("%s is %v, which the product's custody check refuses", dir, di.Mode().Perm())
		}
	}
}

func TestScenarioFilesCannotEscapeTheWorkDirectory(t *testing.T) {
	for _, path := range []string{"../escape", "/etc/escape", "a/../../escape", ""} {
		scn := Scenario{Name: "escape", State: "none", RawConfig: "# placeholder\n",
			Files: []File{{Path: path, Mode: "0644", Content: "x"}}}
		if _, err := Materialize(scn, Options{Work: t.TempDir()}); err == nil {
			t.Errorf("a scenario file at %q should have been refused, and was not", path)
		}
	}
	scn := Scenario{Name: "badmode", State: "none", RawConfig: "# placeholder\n",
		Files: []File{{Path: "x", Mode: "rwx", Content: "x"}}}
	if _, err := Materialize(scn, Options{Work: t.TempDir()}); err == nil {
		t.Error("an unparsable mode should have been refused")
	}
}

// TestGzipFormatWritesARealStream is what lets a case about a reader trust
// its fixture: a file named .gz that is not gzip would make the built-in
// recovery check fail for the fixture's reason, not the product's. The bytes
// inside must still be the deterministic ones, at the size the scenario gave.
func TestGzipFormatWritesARealStream(t *testing.T) {
	scn := func(format string) Scenario {
		return Scenario{
			Name: "gzip-format",
			Sources: []Source{{ID: "production", BackupSets: []BackupSet{{
				ID:         "logs",
				Remote:     Remote{Type: "local"},
				Include:    []string{"*"},
				Completion: Completion{Strategy: "rename"},
				StaleAfter: "30h",
				Artifacts:  []Artifact{{Name: "a.gz", Size: 2048, Seed: "s", Format: format}},
			}}}},
			State: "none",
		}
	}
	raw := read(t, filepath.Join(materialize(t, scn("")).Sets[0].RemotePath, "a.gz"))
	packed := read(t, filepath.Join(materialize(t, scn("gzip")).Sets[0].RemotePath, "a.gz"))
	zr, err := gzip.NewReader(bytes.NewReader(packed))
	if err != nil {
		t.Fatalf("format: gzip did not write a gzip stream: %v", err)
	}
	inner, err := io.ReadAll(zr)
	if err != nil {
		t.Fatalf("reading the stream back: %v", err)
	}
	if !bytes.Equal(inner, raw) {
		t.Error("the stream does not hold the same deterministic bytes the raw file does")
	}
	if again := read(t, filepath.Join(materialize(t, scn("gzip")).Sets[0].RemotePath, "a.gz")); !bytes.Equal(again, packed) {
		t.Error("two materialisations of a gzip artifact differ, so no digest assertion built on it means anything")
	}
	bad := scn("rar")
	if _, err := Materialize(bad, Options{Work: t.TempDir(), Now: time.Now()}); err == nil {
		t.Error("an unknown format was accepted, so a typo would write a raw file and the case would pass for the wrong reason")
	}
}
