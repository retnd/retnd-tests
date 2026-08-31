// Package selftest proves the harness can fail.
//
// This is the RED half of a test-suite deliverable, and it is not a
// one-time ritual. When the artefact being built is the tests themselves,
// "it went green" is not evidence of anything: a harness that silently
// asserts nothing goes green too, and looks identical from the outside.
// So each of the four assertion dimensions is fed a deliberately wrong
// expectation here and has to come back red with a message a human could
// act on, and each is then fed the corrected expectation and has to come
// back clean.
//
// The dimensions are exercised separately on purpose. A single "wrong
// expectation fails" test would pass even if three of the four dimensions
// were never evaluated at all, which is exactly the hole this file
// exists to close.
package selftest

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/spdrman/rclone-manager-tests/suites/cli/harness"
)

var runner *harness.Runner

func TestMain(m *testing.M) {
	r, err := harness.FromPin(".")
	if err != nil {
		// A self-test that cannot reach the build under test has proved
		// nothing, so it fails rather than skipping.
		panic("harness selftest setup: " + err.Error())
	}
	runner = r
	os.Exit(m.Run())
}

// baseline is a case that passes: `check` against the seeded fixture.
// Every self-test below starts from this and breaks exactly one thing.
func baseline() harness.Case {
	return harness.Case{
		Name:     "selftest/baseline",
		Scenario: "seeded-local",
		Argv:     []string{"check", "--config", "${CONFIG}"},
		Exit:     0,
		Stdout: harness.Stream{Mode: "matchers", Matchers: []harness.Matcher{
			{Line: "config OK: 1 source(s), 2 backup set(s)"},
		}},
		Stderr:   harness.Stream{Mode: "empty"},
		State:    harness.StateExpect{Mode: "unchanged"},
		Contract: []string{"selftest"},
	}
}

func run(t *testing.T, c harness.Case) []harness.Mismatch {
	t.Helper()
	work := workDir(t)
	res, err := runner.Run(work, c)
	if err != nil {
		t.Fatalf("running the case: %v", err)
	}
	return harness.Evaluate(c, res)
}

// TestBaselinePasses is the positive control for every negative below. A
// red result only means something if the same case, unbroken, is green.
func TestBaselinePasses(t *testing.T) {
	if got := run(t, baseline()); len(got) != 0 {
		t.Fatalf("the baseline case is supposed to pass, got %d mismatch(es):\n%v", len(got), got)
	}
}

func TestExitCodeDimensionCanFail(t *testing.T) {
	c := baseline()
	c.Exit = 7

	got := run(t, c)
	assertOnly(t, got, "exit")
	assertReadable(t, got[0], "expected exit 7", "got 0")

	c.Exit = 0
	if got := run(t, c); len(got) != 0 {
		t.Fatalf("correcting the exit expectation should clear it, got %v", got)
	}
}

func TestStdoutDimensionCanFail(t *testing.T) {
	c := baseline()
	c.Stdout.Matchers = []harness.Matcher{{Line: "config OK: 9 source(s), 9 backup set(s)"}}

	got := run(t, c)
	assertOnly(t, got, "stdout")
	// The diff has to show what was actually printed, or a failing case
	// tells whoever reads it nothing they did not already know.
	assertReadable(t, got[0], "9 source(s)", "config OK: 1 source(s), 2 backup set(s)")

	c.Stdout.Matchers = []harness.Matcher{{Line: "config OK: 1 source(s), 2 backup set(s)"}}
	if got := run(t, c); len(got) != 0 {
		t.Fatalf("correcting the stdout expectation should clear it, got %v", got)
	}
}

// TestStdoutAbsentMatcherCanFail is the positive control for every
// `absent:` assertion in the matrix. A matcher that can only ever pass is
// worse than no matcher, because it looks like coverage.
func TestStdoutAbsentMatcherCanFail(t *testing.T) {
	c := baseline()
	c.Stdout.Matchers = []harness.Matcher{{Absent: "config OK"}}

	got := run(t, c)
	assertOnly(t, got, "stdout")
	assertReadable(t, got[0], "never to mention", "config OK")

	c.Stdout.Matchers = []harness.Matcher{{Absent: "a string the binary never prints"}}
	if got := run(t, c); len(got) != 0 {
		t.Fatalf("an absent matcher for a string that really is absent should pass, got %v", got)
	}
}

func TestStderrDimensionCanFail(t *testing.T) {
	// `check` against a config that is not there writes to stderr and
	// nothing to stdout, which is what makes it the right probe for this
	// dimension: the expectation being broken is about stderr alone.
	c := baseline()
	c.Argv = []string{"check", "--config", "${WORK}/no-such-config.yaml"}
	c.Exit = 1
	c.Stdout = harness.Stream{Mode: "empty"}
	c.Stderr = harness.Stream{Mode: "empty"}

	got := run(t, c)
	assertOnly(t, got, "stderr")
	assertReadable(t, got[0], "expected nothing on stderr", "no-such-config.yaml")

	c.Stderr = harness.Stream{Mode: "matchers", Matchers: []harness.Matcher{{Contains: "no such file or directory"}}}
	if got := run(t, c); len(got) != 0 {
		t.Fatalf("correcting the stderr expectation should clear it, got %v", got)
	}
}

// TestStateDimensionCanFail breaks the dimension the binary's own output
// cannot be asked about. A command that transfers a file and writes a
// journal row has to be caught by `state: unchanged`, or every dry-run
// case in the matrix is decoration.
func TestStateDimensionCanFail(t *testing.T) {
	c := baseline()
	c.Scenario = "fresh-local"
	c.Argv = []string{"fetch", "--config", "${CONFIG}", "--source", "production", "--backup-set", "app-uploads"}
	c.Stdout = harness.Stream{Mode: "ignored"}
	c.State = harness.StateExpect{Mode: "unchanged"}

	got := run(t, c)
	assertOnly(t, got, "state")
	assertReadable(t, got[0], "untouched", "uploads-2026-06-01.tar")

	c.State = harness.StateExpect{Mode: "changed"}
	if got := run(t, c); len(got) != 0 {
		t.Fatalf("correcting the state expectation should clear it, got %v", got)
	}
}

// TestStateChangedCanFail closes the other direction. `state: changed` is
// the weaker of the two claims, so it needs its own proof that it is not
// simply always true.
func TestStateChangedCanFail(t *testing.T) {
	c := baseline()
	c.State = harness.StateExpect{Mode: "changed"}

	got := run(t, c)
	assertOnly(t, got, "state")
	assertReadable(t, got[0], "expected the work directory to change")
}

// TestFilesPresentCanFail proves the file-level state claims are real
// too, since they are evaluated separately from the whole-directory diff.
func TestFilesPresentCanFail(t *testing.T) {
	c := baseline()
	c.State = harness.StateExpect{Mode: "unchanged", FilesPresent: []string{"${WORK}/a-file-nothing-creates"}}

	got := run(t, c)
	assertOnly(t, got, "state")
	assertReadable(t, got[0], "a-file-nothing-creates")

	c.State = harness.StateExpect{Mode: "unchanged", FilesPresent: []string{"${CONFIG}"}}
	if got := run(t, c); len(got) != 0 {
		t.Fatalf("a files_present claim about a file that is there should pass, got %v", got)
	}
}

// TestNDJSONMatcherCanFail covers the FR-23 assertions, which are parsed
// rather than compared as text and so could plausibly go wrong in their
// own way.
func TestNDJSONMatcherCanFail(t *testing.T) {
	c := baseline()
	c.Scenario = "fresh-local"
	c.Argv = []string{"fetch", "--config", "${CONFIG}", "--source", "production", "--backup-set", "app-uploads"}
	c.State = harness.StateExpect{Mode: "changed"}
	c.Stdout = harness.Stream{Mode: "matchers", Matchers: []harness.Matcher{
		{NDJSON: map[string]string{"event": "an_event_that_does_not_exist"}},
	}}

	got := run(t, c)
	assertOnly(t, got, "stdout")
	assertReadable(t, got[0], "an_event_that_does_not_exist")

	c.Stdout.Matchers = []harness.Matcher{{NDJSON: map[string]string{"event": "startup"}}}
	if got := run(t, c); len(got) != 0 {
		t.Fatalf("an NDJSON matcher for an event that is really emitted should pass, got %v", got)
	}
}

// TestCountMatcherCanFail covers the matcher several cases lean on to
// say "these are all the lines there are", which is the only way a case
// notices an artifact silently left out of a listing.
func TestCountMatcherCanFail(t *testing.T) {
	c := baseline()
	wrong := 99
	c.Stdout.Matchers = []harness.Matcher{{Count: &wrong}}

	got := run(t, c)
	assertOnly(t, got, "stdout")
	assertReadable(t, got[0], "exactly 99 line(s)", "config OK")

	right := 2
	c.Stdout.Matchers = []harness.Matcher{{Count: &right}}
	if got := run(t, c); len(got) != 0 {
		t.Fatalf("the correct line count should pass, got %v", got)
	}
}

func assertOnly(t *testing.T, got []harness.Mismatch, dimension string) {
	t.Helper()
	if len(got) == 0 {
		t.Fatalf("the %s dimension was broken on purpose and the harness reported nothing.\n"+
			"That means this dimension is not actually being asserted, and every case that relies on it is decoration.", dimension)
	}
	for _, m := range got {
		if m.Dimension != dimension {
			t.Fatalf("breaking the %s dimension also reported a %s mismatch, so the dimensions are not independent:\n%s",
				dimension, m.Dimension, m)
		}
	}
}

// assertReadable checks that a failure message says enough for someone to
// act on it. A harness that fails with "assertion failed" is only
// marginally better than one that does not fail at all.
func assertReadable(t *testing.T, m harness.Mismatch, wants ...string) {
	t.Helper()
	for _, w := range wants {
		if !strings.Contains(m.Message, w) {
			t.Errorf("the %s failure message does not mention %q, so it is not readable enough to act on:\n%s",
				m.Dimension, w, m.Message)
		}
	}
}

func workDir(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs("../../../../.work")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	dir, err := os.MkdirTemp(root, "selftest-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}
