package cli_test

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/backupdproject/backupd-tests/suites/cli/harness"
)

// TestRetentionOverrideItemisationSurvivesTheUTCMidnightBoundary is the
// control issue #270 requires.
//
// retention/override-flags-narrow-the-itemisation.yaml seeds
// pg-06-age-000d.dump's producer timestamp as an offset from the Runner's
// own Now, which suites/cli/suite_test.go resolves once, at TestMain, from
// the real clock. The case's own retention invocation reads the real
// clock again, later and separately, once for the discovery pass's
// DiscoveredAt (set inside the replay fetch this scenario runs to seed its
// catalog) and once more for the window the retention command itself
// evaluates "today" against. Ordinarily those two clock reads land on the
// same UTC day, seconds apart, and the case's pinned tier attribution
// (DAILY(both) WEEKLY(both) MONTHLY(both)) holds. In the last moments of
// any UTC day they do not have to: the Runner's Now can be pinned before
// midnight while the retention command's own "today" has already ticked
// over, which pushes pg-06's producer placement out of a tier window
// narrowed to exactly "today" (--daily-days 1 here) and flips that tier's
// attribution to discovery-only. See backupd#270.
//
// This test forces that exact crossing on every run, on every day of the
// year, without needing to run at an actual midnight: it builds its own
// Runner (rather than the package's shared one, whose Now the whole suite
// run has to agree on) with Now pinned to 23:59:59 UTC on the day before
// whatever day the test actually executes on. The producer timestamp that
// buys is always yesterday by construction; the CLI's own real-time reads,
// moments later in the same test, are always today. The case is expected
// to pass regardless: this is the RED/GREEN control for making the case's
// assertion tolerate whichever placement resolved the artifact, since
// which one used up its "own" evidence and which one uses the union's
// other, still-trustworthy leg is not what this case's override flags are
// claiming, and gfs-tiers-from-one-ingest.yaml already carries the
// placement-attribution claim on its own, unnarrowed windows.
func TestRetentionOverrideItemisationSurvivesTheUTCMidnightBoundary(t *testing.T) {
	c, err := harness.LoadCase(
		filepath.Join(repoRoot, "suites", "cli", "cases"),
		filepath.Join(repoRoot, "suites", "cli", "cases", "retention", "override-flags-narrow-the-itemisation.yaml"),
	)
	if err != nil {
		t.Fatalf("loading the case: %v", err)
	}

	realToday := time.Now().UTC()
	boundary := time.Date(realToday.Year(), realToday.Month(), realToday.Day(), 23, 59, 59, 0, time.UTC).AddDate(0, 0, -1)
	t.Logf("materialising with Now pinned to %s (yesterday's last second, UTC); the CLI's own clock reads moments from now, which is %s",
		boundary, realToday)

	boundaryRunner := &harness.Runner{
		CLI:            runner.CLI,
		ScenarioDir:    runner.ScenarioDir,
		DefaultTimeout: runner.DefaultTimeout,
		Now:            boundary,
	}

	work := newWork(t, "boundary_"+c.Name)
	res, err := boundaryRunner.Run(work, c)
	if err != nil {
		t.Fatalf("%s\n\n(case %s, work directory %s)", err, c.Path, work)
	}

	if mismatches := harness.Evaluate(c, res); len(mismatches) != 0 {
		for _, m := range mismatches {
			t.Errorf("[%s] %s", m.Dimension, m.Message)
		}
		t.Logf("case file: %s\nwork directory: %s\nargv: %v", c.Path, work, res.Argv)
	}
}
