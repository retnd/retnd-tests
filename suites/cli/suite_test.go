// Package cli_test is Suite A: the black-box CLI contract suite.
//
// Every case is a YAML file under cases/, one per cell of COVERAGE.md,
// and every case asserts all four dimensions the issue names: exit code,
// stdout, stderr, and resulting on-disk state. The runner refuses a case
// that leaves any of them unstated, because the dimension nobody asserted
// is where a regression lives.
package cli_test

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/retnd/retnd-tests/suites/cli/harness"
	"github.com/retnd/retnd-tests/tools/getbuild"
)

var (
	runner   *harness.Runner
	repoRoot string
)

// TestMain resolves the build under test once and makes it prove its own
// identity before a single case runs.
//
// The handshake is a hard precondition rather than a test of its own on
// purpose. If the binary cannot say which commit it is, every green below
// would be a statement about an unknown build, and this campaign has
// already had one control report green against a stale server from a
// different commit. A suite that certifies an unknown build is worse than
// a suite that refuses to run.
func TestMain(m *testing.M) {
	flag.Parse()
	code, err := setup()
	if err != nil {
		fmt.Fprintln(os.Stderr, "suite A setup:", err)
		os.Exit(1)
	}
	if code != 0 {
		os.Exit(code)
	}
	os.Exit(m.Run())
}

func setup() (int, error) {
	root, err := getbuild.RepoRoot(".")
	if err != nil {
		return 1, err
	}
	repoRoot = root

	pin, err := getbuild.LoadPin(root)
	if err != nil {
		return 1, err
	}
	build, err := getbuild.Resolve(root, pin)
	if err != nil {
		return 1, err
	}
	info, err := getbuild.Handshake(build)
	if err != nil {
		return 1, err
	}
	fmt.Printf("build under test: %s\n  %s\n  reports: %s / commit %s / rclone %s / %s\n",
		build.CLI, build.Provenance, info.BinaryVersion, info.Commit, info.Rclone, info.Go)

	runner, err = harness.FromPin(root)
	if err != nil {
		return 1, err
	}
	return 0, nil
}

// TestCLIContract runs every case under cases/.
func TestCLIContract(t *testing.T) {
	cases, err := harness.LoadCases(filepath.Join(repoRoot, "suites", "cli", "cases"))
	if err != nil {
		t.Fatalf("loading cases: %v", err)
	}
	if len(cases) == 0 {
		// An empty run is not a pass. A glob that matches nothing looks
		// exactly like a suite where everything passed, and that
		// confusion has cost this estate real time before.
		t.Fatal("no cases found under suites/cli/cases: a suite that runs nothing is not a suite that passes")
	}

	only := os.Getenv("RETND_TAGS")
	ran := 0
	for _, c := range cases {
		if only != "" && !matchesTags(c, only) {
			continue
		}
		ran++
		t.Run(c.Name, func(t *testing.T) {
			runCase(t, c)
		})
	}
	if ran == 0 {
		t.Fatalf("RETND_TAGS=%q selected none of the %d case(s)", only, len(cases))
	}
	t.Logf("ran %d of %d case(s)", ran, len(cases))
}

func runCase(t *testing.T, c harness.Case) {
	t.Helper()
	work := newWork(t, c.Name)

	res, err := runner.Run(work, c)
	if err != nil {
		t.Fatalf("%s\n\n(case %s, work directory %s)", err, c.Path, work)
	}
	mismatches := harness.Evaluate(c, res)

	// Strict expected failure, per dimension. A case marked
	// known_discrepancy asserts the documented contract; the product
	// currently does something else; the finding is filed. Mismatches in
	// the marked dimensions are the expected outcome, mismatches anywhere
	// else are real failures, and a marked dimension that stops
	// mismatching fails on purpose, so a fix forces the marker's removal
	// instead of quietly leaving a stale entry in the discrepancy list.
	var expected, unexpected []harness.Mismatch
	for _, m := range mismatches {
		if c.ExpectedFailure(m.Dimension) {
			expected = append(expected, m)
			continue
		}
		unexpected = append(unexpected, m)
	}

	for _, m := range unexpected {
		t.Errorf("[%s] %s", m.Dimension, m.Message)
	}
	if c.KnownDiscrepancy != "" {
		if len(expected) == 0 {
			t.Errorf("case %s is marked known_discrepancy %s but the marked dimension(s) now agree with the contract.\n"+
				"That is a failure on purpose: remove the marker and the entry in findings/, or the discrepancy list rots.",
				c.Name, c.KnownDiscrepancy)
		} else {
			t.Logf("known discrepancy %s still stands; see findings/", c.KnownDiscrepancy)
			for _, m := range expected {
				t.Logf("  %s", m)
			}
		}
	}
	if t.Failed() {
		t.Logf("case file: %s\nwork directory: %s\ncontract: %s\nargv: %v",
			c.Path, work, strings.Join(c.Contract, ", "), res.Argv)
	}
}

func matchesTags(c harness.Case, spec string) bool {
	for _, tag := range strings.Split(spec, ",") {
		tag = strings.TrimSpace(tag)
		if tag != "" && c.HasTag(tag) {
			return true
		}
	}
	return false
}

// newWork builds a per-case work directory inside the repository rather
// than in the system temp area. Two reasons: a failed case leaves its
// fixture behind where it is easy to look at (RETND_KEEP_WORK=1 keeps it),
// and every file this suite creates or destroys stays inside the
// workspace it belongs to.
func newWork(t *testing.T, name string) string {
	t.Helper()
	safe := strings.NewReplacer("/", "_", " ", "_", ":", "_").Replace(name)
	dir, err := os.MkdirTemp(workRoot(t), safe+"-")
	if err != nil {
		t.Fatalf("creating a work directory: %v", err)
	}
	if os.Getenv("RETND_KEEP_WORK") == "" {
		t.Cleanup(func() { _ = os.RemoveAll(dir) })
	} else {
		t.Cleanup(func() { t.Logf("work directory kept at %s", dir) })
	}
	return dir
}

func workRoot(t *testing.T) string {
	t.Helper()
	root := filepath.Join(repoRoot, ".work")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatalf("creating %s: %v", root, err)
	}
	return root
}

// TestCoverageDocumentIsInLockstep keeps COVERAGE.md honest.
//
// A coverage document exists so gaps are visible rather than implied, and
// the way one stops doing that is by drifting: cases get added, the
// document does not, and it slowly becomes a description of a suite that
// no longer exists. This makes the drift a failure instead.
func TestCoverageDocumentIsInLockstep(t *testing.T) {
	path := filepath.Join(repoRoot, "suites", "cli", "COVERAGE.md")
	doc, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading the coverage matrix: %v", err)
	}
	cases, err := harness.LoadCases(filepath.Join(repoRoot, "suites", "cli", "cases"))
	if err != nil {
		t.Fatalf("loading cases: %v", err)
	}

	var missing []string
	for _, c := range cases {
		if !strings.Contains(string(doc), c.Name) {
			missing = append(missing, c.Name)
		}
	}
	if len(missing) > 0 {
		t.Errorf("%d case(s) exist but are not in the coverage matrix, so the matrix understates what is covered:\n  %s\n(add them to %s)",
			len(missing), strings.Join(missing, "\n  "), path)
	}
}
