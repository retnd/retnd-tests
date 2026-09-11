// Command mkfixture materialises one fixture scenario and prints its
// manifest as JSON.
//
// Suite A imports fixtures/lib directly. This exists for the suites that
// cannot: Suite B once it converges onto the shared fixture layer, and
// Suite C, both of which are TypeScript. They shell out to this rather
// than reimplementing scenario materialisation in Node, so there stays
// exactly one definition of what a scenario is. Two implementations would
// eventually disagree, and the first time they did, a suite would be
// asserting against a situation the other suite could not produce.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"time"

	getbuild "github.com/backupdproject/backupd-tests/tools/getbuild"

	fixtures "github.com/backupdproject/backupd-tests/fixtures/lib"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "mkfixture:", err)
		os.Exit(1)
	}
}

func run() error {
	scenario := flag.String("scenario", "", "scenario name under fixtures/scenarios")
	work := flag.String("work", "", "directory to materialise into (must exist)")
	cli := flag.String("cli", "", "backupd binary used for replay seeding; resolved from the pin when empty")
	// --now anchors every relative mtime in the scenario. It exists for
	// callers that materialise the same scenario more than once and need
	// the copies to be identical rather than merely equivalent: Suite C
	// builds a UI side and a CLI side of every pair, and without a shared
	// anchor the two runs straddle a second boundary often enough to
	// matter, which lands as artifacts whose remote mtimes differ by a
	// second. Nothing used to see that. FR-19's reason line now prints
	// the artifact's resolved date, so the two sides' retention previews
	// disagree in the one place the comparison reads.
	now := flag.String("now", "", "RFC3339 instant to anchor relative mtimes against (default: the moment this runs)")
	flag.Parse()

	if *scenario == "" || *work == "" {
		return fmt.Errorf("both --scenario and --work are required")
	}
	var anchor time.Time
	if *now != "" {
		var err error
		anchor, err = time.Parse(time.RFC3339Nano, *now)
		if err != nil {
			return fmt.Errorf("--now: %w", err)
		}
		if anchor.IsZero() {
			return fmt.Errorf("--now: the zero time means \"use the clock\" to fixtures.Materialize, so it cannot be asked for explicitly")
		}
	}
	root, err := getbuild.RepoRoot(".")
	if err != nil {
		return err
	}
	binary := *cli
	if binary == "" {
		pin, err := getbuild.LoadPin(root)
		if err != nil {
			return err
		}
		build, err := getbuild.Resolve(root, pin)
		if err != nil {
			return err
		}
		if _, err := getbuild.Handshake(build); err != nil {
			return err
		}
		binary = build.CLI
	}

	scn, err := fixtures.Load(filepath.Join(root, "fixtures", "scenarios"), *scenario)
	if err != nil {
		return err
	}
	manifest, err := fixtures.Materialize(scn, fixtures.Options{Work: *work, CLI: binary, Now: anchor})
	if err != nil {
		return err
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(manifest)
}
