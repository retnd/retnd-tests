// Command statesnap snapshots a work directory, or diffs two snapshots.
//
// Suite A uses the library. This CLI exists so the browser-driven suites,
// and a human debugging a failure, can reach the same normalised view of
// backend state without a second implementation of "what counts as
// state" growing up in TypeScript beside this one. Suite C in particular
// compares a UI-driven side against a CLI-driven side, and if the two
// sides could disagree about what state is, the comparison would be
// meaningless.
//
//	statesnap take  --root DIR [--db PATH] [-o snap.json]
//	statesnap diff  before.json after.json
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"github.com/spdrman/backupd-tests/tools/statesnap"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "statesnap:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("usage: statesnap take --root DIR [--db PATH] [-o FILE] | statesnap diff BEFORE AFTER")
	}
	switch args[0] {
	case "take":
		fs := flag.NewFlagSet("take", flag.ContinueOnError)
		root := fs.String("root", "", "directory to snapshot")
		db := fs.String("db", "", "path to the state database, if any")
		out := fs.String("o", "", "write the snapshot here instead of stdout")
		if err := fs.Parse(args[1:]); err != nil {
			return err
		}
		if *root == "" {
			return fmt.Errorf("take: --root is required")
		}
		snap, err := statesnap.Take(*root, *db)
		if err != nil {
			return err
		}
		encoded, err := json.MarshalIndent(snap, "", "  ")
		if err != nil {
			return err
		}
		if *out == "" {
			fmt.Println(string(encoded))
			return nil
		}
		return os.WriteFile(*out, append(encoded, '\n'), 0o644)

	case "diff":
		if len(args) != 3 {
			return fmt.Errorf("diff: expected two snapshot files")
		}
		before, err := readSnapshot(args[1])
		if err != nil {
			return err
		}
		after, err := readSnapshot(args[2])
		if err != nil {
			return err
		}
		d := statesnap.Compare(before, after)
		fmt.Println(d.String())
		if !d.Empty() {
			os.Exit(1)
		}
		return nil

	default:
		return fmt.Errorf("unknown subcommand %q (expected take or diff)", args[0])
	}
}

func readSnapshot(path string) (statesnap.Snapshot, error) {
	var s statesnap.Snapshot
	raw, err := os.ReadFile(path)
	if err != nil {
		return s, err
	}
	return s, json.Unmarshal(raw, &s)
}
