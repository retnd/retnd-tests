// Package equivstate answers Suite C's one question: after the same
// change was made through the Web UI on one work directory and through
// the CLI on another, is the resulting backend state the same?
//
// It lives in Go, next to statesnap, rather than in the TypeScript suite
// that calls it, for the reason statesnap's own doc gives: if the two
// sides of an equivalence test could disagree about what state IS, the
// comparison would be meaningless. Suite C shells out to this exactly as
// it shells out to mkfixture.
//
// "Backend state" here is deliberately two things, because a work
// directory has two kinds of truth in it and only one of them is a file:
//
//   - the filesystem and the catalog, through statesnap. Byte digests for
//     ordinary files, a logical table-by-table dump for the FR-9 state
//     database.
//   - the product's own read surface, by running read-only commands
//     against both directories with the SAME binary and comparing what
//     they print. That is the better oracle wherever it reaches, because
//     it compares what an operator can actually observe rather than an
//     internal representation two correct implementations could differ on.
//
// Both halves are needed. The read surface does not expose everything the
// catalog holds, and the catalog holds machine-specific things (absolute
// paths, ingest timestamps) that two independent runs will legitimately
// differ on. So each half carries an explicit, named list of what it
// ignores, and the lists are arguments rather than hidden defaults: a
// comparison that quietly ignores the thing under test is the failure
// mode this whole repository exists to avoid.
package equivstate

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/spdrman/backupd-tests/tools/statesnap"
)

// ReadCommands are the read-only invocations the comparison runs against
// both sides. Every one of them is a command an operator would use to ask
// "what does the service think is true", and none of them writes.
var ReadCommands = [][]string{
	{"sources"},
	{"artifacts"},
	{"status"},
	{"check"},
	{"retention", "--dry-run"},
}

// Options controls one comparison.
type Options struct {
	// CLI is the backupd binary both sides are read with. One
	// binary, not two: the claim is about two work directories, and a
	// second binary would put a second variable in it.
	CLI string
	// A and B are the two work directories.
	A, B string
	// IgnoreFiles are path suffixes excluded from the filesystem half.
	// config.yaml belongs here whenever one side was written by the
	// engine's own YAML writer and the other by hand: the two are
	// semantically equal and textually different, and the read surface is
	// what settles whether they mean the same thing.
	IgnoreFiles []string
	// MaskVolatile replaces the four things that are properties of the
	// machine and the moment rather than of the backend: absolute
	// timestamps, durations, relative times ("3 hours ago"), and the
	// host filesystem's free-space reading. It applies to both halves,
	// the read surface and the text content of files whose digests
	// differ.
	//
	// Off by default and named per comparison, so a spec that needs it
	// says so where a reader can see it, the same way Suite A's
	// expectations carry a visible ${TS} rather than having one
	// normalised away behind their back. Nothing else is masked: an
	// artifact size, a count and a state name are all contractual, and a
	// mask that swallowed them would turn this comparison green by
	// looking away.
	MaskVolatile bool
}

// Result is what a comparison found. Empty means the two sides agree.
type Result struct {
	FileDiff   statesnap.Diff
	ReadDiffs  []ReadDiff
	FileErr    string
	Compared   []string
	IgnoredHit []string
	// MaskedFiles are files whose bytes differ but whose masked text is
	// identical, so the difference was entirely volatile values. Reported
	// rather than silently dropped: a comparison that hides what it
	// forgave cannot be reviewed.
	MaskedFiles []string
}

// ReadDiff is one read command that printed different things on the two
// sides, rendered as a unified-ish line list.
type ReadDiff struct {
	Argv []string
	A    []string
	B    []string
	Note string
}

// Equal reports whether the two sides agree on everything compared.
func (r Result) Equal() bool { return r.FileErr == "" && r.FileDiff.Empty() && len(r.ReadDiffs) == 0 }

// Compare runs both halves and returns what differs.
func Compare(o Options) (Result, error) {
	var res Result

	a, err := statesnap.Take(o.A, filepath.Join(o.A, "state", "state.db"))
	if err != nil {
		return res, fmt.Errorf("snapshotting %s: %w", o.A, err)
	}
	b, err := statesnap.Take(o.B, filepath.Join(o.B, "state", "state.db"))
	if err != nil {
		return res, fmt.Errorf("snapshotting %s: %w", o.B, err)
	}
	res.IgnoredHit = dropIgnored(&a, o.IgnoreFiles)
	dropIgnored(&b, o.IgnoreFiles)
	// The catalog is compared through the read surface below, not here:
	// two independent runs write different ingest timestamps into it, and
	// a raw row diff would report that as an inequality every time.
	a.DB, b.DB = statesnap.DB{}, statesnap.DB{}
	res.FileDiff = statesnap.Compare(a, b)
	if o.MaskVolatile {
		res.FileDiff.Changed, res.MaskedFiles = forgiveVolatileFiles(res.FileDiff.Changed, o.A, o.B)
	}

	for _, argv := range ReadCommands {
		outA, errA := readSurface(o.CLI, o.A, argv)
		outB, errB := readSurface(o.CLI, o.B, argv)
		if errA != nil || errB != nil {
			res.ReadDiffs = append(res.ReadDiffs, ReadDiff{
				Argv: argv,
				Note: fmt.Sprintf("could not read both sides: A=%v B=%v", errA, errB),
			})
			continue
		}
		linesA := normalize(outA, o.A, o.MaskVolatile)
		linesB := normalize(outB, o.B, o.MaskVolatile)
		res.Compared = append(res.Compared, strings.Join(argv, " "))
		if !equalLines(linesA, linesB) {
			res.ReadDiffs = append(res.ReadDiffs, ReadDiff{Argv: argv, A: linesA, B: linesB})
		}
	}
	return res, nil
}

func dropIgnored(s *statesnap.Snapshot, ignore []string) []string {
	var hit []string
	for path := range s.Files {
		for _, suffix := range ignore {
			if strings.HasSuffix(path, suffix) {
				hit = append(hit, path)
				delete(s.Files, path)
				break
			}
		}
	}
	sort.Strings(hit)
	return hit
}

// readSurface runs one read command against one work directory. Output
// and exit status are both returned as text: `status` exits 1 for
// anything short of HEALTHY (FR-24), so its exit code is part of what the
// two sides have to agree on rather than an error to abort on.
func readSurface(cli, work string, argv []string) (string, error) {
	full := append(append([]string{}, argv...), "--config", filepath.Join(work, "config.yaml"))
	cmd := exec.Command(cli, full...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	code := 0
	if err := cmd.Run(); err != nil {
		exitErr, ok := err.(*exec.ExitError)
		if !ok {
			return "", err
		}
		code = exitErr.ExitCode()
	}
	return fmt.Sprintf("exit %d\n--- stdout\n%s--- stderr\n%s", code, stdout.String(), stderr.String()), nil
}

var (
	reTimestamp = regexp.MustCompile(`\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?`)
	reDuration  = regexp.MustCompile(`\b\d+(\.\d+)?(ns|µs|us|ms|s|m|h)\b`)
	reRelative  = regexp.MustCompile(`\b\d+(\.\d+)? ?(second|minute|hour|day)s?\b`)
	// The host filesystem's free space, which `status` reports and which
	// changes between two consecutive invocations on a busy machine. It is
	// not backend state at all, so it is masked by pattern rather than by
	// masking byte counts generally: an artifact's size IS contractual.
	reFreeSpace = regexp.MustCompile(`free space: \d+ bytes`)
)

// maskVolatile rewrites the four machine-and-moment values out of a piece
// of text. Used on both the read surface and file content.
func maskVolatile(s string) string {
	s = reTimestamp.ReplaceAllString(s, "${TS}")
	s = reFreeSpace.ReplaceAllString(s, "free space: ${BYTES} bytes")
	s = reDuration.ReplaceAllString(s, "${DUR}")
	s = reRelative.ReplaceAllString(s, "${REL}")
	return s
}

// maskRoot rewrites one run's own working directory out of a piece of text.
//
// The sidecar manifests record an artifact's location as an ABSOLUTE path,
// and the two sides of a comparison run in two different temporary
// directories, so every manifest differs in the one field that is a
// property of where the run happened rather than of what it did. Worse, the
// two directory names are not the same length, so the difference shows up
// as a size difference too and reads like a content change.
//
// Only the root is replaced, never the tail. A manifest that genuinely
// records a different path UNDER the root still differs after masking,
// which is the whole point: this forgives where the run happened and
// nothing about what it wrote.
func maskRoot(s, root string) string {
	if root == "" {
		return s
	}
	return strings.ReplaceAll(s, root, "${ROOT}")
}

// forgiveVolatileFiles drops the entries of a changed-file list whose two
// sides are byte-different but identical once volatile values are masked,
// and returns what it dropped so the caller can report it.
//
// The sidecar recovery manifests are the reason this exists: they record
// when an artifact was ingested, so two independent runs of the same
// scenario write different bytes while recording the same facts. Ignoring
// the whole file would hide a real difference in what it records; masking
// the timestamps inside it does not.
func forgiveVolatileFiles(changed []string, aRoot, bRoot string) (kept, masked []string) {
	for _, entry := range changed {
		path := entry
		if i := strings.Index(entry, " ("); i >= 0 {
			path = entry[:i]
		}
		aText, aOK := readText(filepath.Join(aRoot, path))
		bText, bOK := readText(filepath.Join(bRoot, path))
		if aOK && bOK && maskRoot(maskVolatile(aText), aRoot) == maskRoot(maskVolatile(bText), bRoot) {
			masked = append(masked, path)
			continue
		}
		kept = append(kept, entry)
	}
	sort.Strings(masked)
	return kept, masked
}

// readText reads a file if it is small enough to compare as text and is
// valid UTF-8. A binary file is never forgiven by masking.
func readText(path string) (string, bool) {
	info, err := os.Stat(path)
	if err != nil || info.Size() > 1<<20 {
		return "", false
	}
	raw, err := os.ReadFile(path)
	if err != nil || !utf8.Valid(raw) {
		return "", false
	}
	return string(raw), true
}

func normalize(out, work string, mask bool) []string {
	out = strings.ReplaceAll(out, work, "${WORK}")
	if mask {
		out = maskVolatile(out)
	}
	lines := strings.Split(out, "\n")
	for len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	return lines
}

func equalLines(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// Render turns a Result into the failure text a person reads. Minimal on
// purpose: the first differing line of each command, not both streams in
// full, because a comparison that prints two thousand lines is one nobody
// reviews.
func Render(r Result) string {
	var b strings.Builder
	if len(r.MaskedFiles) > 0 {
		fmt.Fprintf(&b, "forgiven as volatile-only (bytes differ, masked text identical): %s\n", strings.Join(r.MaskedFiles, ", "))
	}
	if r.Equal() {
		b.WriteString("the two sides agree on every compared dimension\n")
		return b.String()
	}
	if r.FileErr != "" {
		fmt.Fprintf(&b, "filesystem: %s\n", r.FileErr)
	}
	if !r.FileDiff.Empty() {
		b.WriteString("filesystem differs:\n")
		for _, line := range strings.Split(r.FileDiff.String(), "\n") {
			if line != "" {
				fmt.Fprintf(&b, "  %s\n", line)
			}
		}
	}
	for _, d := range r.ReadDiffs {
		fmt.Fprintf(&b, "`backupd %s` differs between the two sides", strings.Join(d.Argv, " "))
		if d.Note != "" {
			fmt.Fprintf(&b, ": %s\n", d.Note)
			continue
		}
		b.WriteString(":\n")
		for _, line := range firstDifference(d.A, d.B) {
			fmt.Fprintf(&b, "  %s\n", line)
		}
	}
	return b.String()
}

func firstDifference(a, b []string) []string {
	n := len(a)
	if len(b) < n {
		n = len(b)
	}
	for i := 0; i < n; i++ {
		if a[i] != b[i] {
			return []string{
				fmt.Sprintf("line %d, UI side : %s", i+1, a[i]),
				fmt.Sprintf("line %d, CLI side: %s", i+1, b[i]),
			}
		}
	}
	return []string{fmt.Sprintf("the two sides agree for %d line(s), then one has %d line(s) and the other %d", n, len(a), len(b))}
}
