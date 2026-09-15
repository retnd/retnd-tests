// Command equivstate compares the backend state of two work directories,
// one driven through the Web UI and one through the CLI.
//
// Suite C is TypeScript and this is Go, for the reason statesnap's CLI
// exists: there is exactly one definition of what backend state is, and
// an equivalence test whose two sides could disagree about that would be
// comparing nothing.
//
//	equivstate compare --cli PATH --a DIR --b DIR
//	                   [--ignore-file SUFFIX]... [--mask-volatile]
//
// Exit 0 when the two sides agree, 1 when they differ (with a readable
// report on stdout), 2 for a usage or setup error.
package main

import (
	"flag"
	"fmt"
	"os"
	"strings"

	"github.com/retnd/retnd-tests/tools/equivstate"
)

type list []string

func (l *list) String() string     { return strings.Join(*l, ",") }
func (l *list) Set(v string) error { *l = append(*l, v); return nil }

func main() {
	fs := flag.NewFlagSet("compare", flag.ContinueOnError)
	cli := fs.String("cli", "", "the retnd binary both sides are read with")
	a := fs.String("a", "", "the work directory driven through the Web UI")
	b := fs.String("b", "", "the work directory driven through the CLI")
	mask := fs.Bool("mask-volatile", false, "mask timestamps, durations, relative times and the host free-space reading, in the read surface and in text file content")
	var ignore list
	fs.Var(&ignore, "ignore-file", "path suffix to exclude from the filesystem comparison (repeatable)")

	args := os.Args[1:]
	if len(args) == 0 || args[0] != "compare" {
		fmt.Fprintln(os.Stderr, "usage: equivstate compare --cli PATH --a DIR --b DIR [--ignore-file SUFFIX]... [--mask-volatile]")
		os.Exit(2)
	}
	if err := fs.Parse(args[1:]); err != nil {
		os.Exit(2)
	}
	if *cli == "" || *a == "" || *b == "" {
		fmt.Fprintln(os.Stderr, "equivstate: --cli, --a and --b are all required")
		os.Exit(2)
	}

	res, err := equivstate.Compare(equivstate.Options{
		CLI: *cli, A: *a, B: *b, IgnoreFiles: ignore, MaskVolatile: *mask,
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, "equivstate:", err)
		os.Exit(2)
	}
	fmt.Print(equivstate.Render(res))
	if !res.Equal() {
		os.Exit(1)
	}
}
