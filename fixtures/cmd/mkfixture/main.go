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

	getbuild "github.com/spdrman/rclone-manager-tests/tools/getbuild"

	fixtures "github.com/spdrman/rclone-manager-tests/fixtures/lib"
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
	cli := flag.String("cli", "", "backup-manager binary used for replay seeding; resolved from the pin when empty")
	flag.Parse()

	if *scenario == "" || *work == "" {
		return fmt.Errorf("both --scenario and --work are required")
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
	manifest, err := fixtures.Materialize(scn, fixtures.Options{Work: *work, CLI: binary})
	if err != nil {
		return err
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(manifest)
}
