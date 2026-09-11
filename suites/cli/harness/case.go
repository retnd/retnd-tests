// Package harness runs one backupd invocation against one fixture
// and decides whether the result matched a checked-in expectation.
//
// # Why there is no golden mode
//
// The obvious way to build this is to run the binary, record its whole
// stdout, and assert byte equality forever after. That produces a change
// detector rather than a validator: it bakes today's bugs in as
// "expected", goes red on a reworded log line, and stays green on a real
// regression as long as the wording holds. Recording output also inverts
// where the contract lives, from the documentation to whatever the binary
// last did.
//
// So this package has no whole-output golden mode at all. Not discouraged
// with a comment, not gated behind a flag: not implemented. An
// expectation can only be written as a list of specific claims about
// specific lines, each of which someone had to derive from a document,
// and every case names its source in its own `contract:` list. When
// derivation and observation disagree, that is a finding to file against
// backupd (see findings/), recorded as a known_discrepancy which
// this runner treats as a strict expected-failure: the case stays red
// while the issue is open, and goes red again the moment it starts
// passing, so a fix forces the marker's removal.
package harness

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

// Case is one cell of suites/cli/COVERAGE.md.
type Case struct {
	// Name defaults to the case file's path relative to cases/.
	Name string `yaml:"-"`
	Path string `yaml:"-"`

	// Doc says, in one line, what contractual claim this case makes.
	Doc string `yaml:"doc"`
	// Scenario names a directory under fixtures/scenarios.
	Scenario string `yaml:"scenario"`
	// Setup is a list of argv to run against the same work directory
	// before the argv under test, for the multi-command sequences where
	// the bug only appears in state carried between commands.
	Setup [][]string `yaml:"setup"`
	// AllowSetupFailure lets a setup step exit nonzero on purpose. It is
	// needed for the sequences whose whole point is what the system looks
	// like after something went wrong, and it is opt-in per case so the
	// default stays "a setup that failed means the case never reached the
	// state it describes, and saying so beats asserting against a
	// situation nobody meant to create".
	AllowSetupFailure bool `yaml:"allow_setup_failure"`
	// Mutate is a list of fixture edits applied after Setup and before
	// Argv: "rm <path>", "truncate <path>", "corrupt <path>". They exist
	// for the loss-and-recovery sequences, which have to be able to
	// destroy something an operator could destroy.
	Mutate []string `yaml:"mutate"`
	// SetupAfterMutate runs between the mutations and the argv under
	// test. Recovery sequences need it: the interesting question is what
	// a read command says after a repair, and the repair can only happen
	// once the damage has.
	SetupAfterMutate [][]string `yaml:"setup_after_mutate"`
	// Argv is the invocation under test, with ${CONFIG} and friends
	// expanded against the materialised fixture.
	Argv []string `yaml:"argv"`
	// InvokeAs runs the argv under test through a second filename for the
	// same binary, rather than through the name the pin resolved. It is
	// how the old command name gets asserted from outside: `backupd` was
	// `backupd` until 0.3.3 and the old spelling still has to
	// work, and a promise like that is exactly the kind that rots
	// silently because nothing an operator runs ever proves it.
	//
	// It is a bare filename, and the harness makes the link itself, so
	// what a case using this asserts is that the binary does not care
	// which name reached it. What it cannot assert is that the shipped
	// image has that second name in it, because in the `go` builder there
	// is no image; that half is container/Dockerfile's, and the two are
	// deliberately not conflated here.
	InvokeAs string `yaml:"invoke_as"`
	// NoArguments says the empty argv is the point. It has to be spelled
	// out rather than inferred from an empty list, so that a case whose
	// argv failed to load reads as a broken case rather than as a
	// deliberate test of the bare binary.
	NoArguments bool `yaml:"no_arguments"`
	// Env adds to (never replaces) the inherited environment.
	Env map[string]string `yaml:"env"`
	// TimeoutSeconds bounds the run. Zero means the suite default.
	TimeoutSeconds int `yaml:"timeout_seconds"`
	// Signal, when set to "TERM" or "INT", is delivered once StopAfter
	// has passed, which is how `daemon` gets a bounded run instead of an
	// infinite loop.
	Signal    string `yaml:"signal"`
	StopAfter string `yaml:"stop_after"`

	Exit   int         `yaml:"exit"`
	Stdout Stream      `yaml:"stdout"`
	Stderr Stream      `yaml:"stderr"`
	State  StateExpect `yaml:"state"`

	// Contract names where this expectation came from: FR numbers,
	// document sections, or the binary's own usage text. A case with an
	// empty contract list is refused by the loader, because an
	// expectation nobody can trace to a document is indistinguishable
	// from a recorded snapshot.
	Contract []string `yaml:"contract"`

	// Tags select subsets. "smoke" is the slice cheap enough to run on
	// every backupd commit; "docker" marks cases needing a
	// container.
	Tags []string `yaml:"tags"`

	// KnownDiscrepancy marks a case whose expectation is what the
	// documented contract says and whose observed behaviour disagrees.
	// The value is the filed issue. Strict expected failure: red while it
	// fails is the expected outcome, and an unexpected pass is a failure.
	KnownDiscrepancy string `yaml:"known_discrepancy"`

	// KnownDiscrepancyDimensions narrows the marker to the dimensions
	// that actually disagree, leaving the rest asserted strictly. Empty
	// means the whole case.
	//
	// This is what stops a discrepancy from becoming a hole. Marking a
	// whole case expected-to-fail because its exit code is wrong would
	// also stop anyone noticing if its output or its on-disk effect
	// regressed, and the case would sit there looking like coverage while
	// covering nothing.
	KnownDiscrepancyDimensions []string `yaml:"known_discrepancy_dimensions"`
}

// Stream is an expectation about stdout or stderr. It is either the bare
// word `empty`, the bare word `ignored`, or a list of matchers.
type Stream struct {
	Mode     string // "empty", "ignored" or "matchers"
	Matchers []Matcher
}

// Matcher is one claim about one line of a stream. Exactly one field is
// set; the loader refuses anything else, so a typo cannot silently make a
// matcher that asserts nothing.
type Matcher struct {
	// Line is an exact line, after path tokenisation, with ${TS}, ${DUR},
	// ${INT}, ${SHA}, ${HOST} and ${ANY} standing in for the parts that
	// are not contractual.
	Line string `yaml:"line"`
	// Re is a regular expression anchored to a whole line.
	Re string `yaml:"re"`
	// Contains is a substring that must appear somewhere in the stream.
	// Used for error text that a terminal may wrap or that carries a
	// wrapped cause.
	Contains string `yaml:"contains"`
	// Absent is a substring that must appear nowhere in the stream. Every
	// use of this needs a positive control elsewhere in the matrix
	// proving the same harness can see the string when it is there.
	Absent string `yaml:"absent"`
	// NDJSON is a field subset that some parsed FR-23 log line on the
	// stream must match.
	NDJSON map[string]string `yaml:"ndjson"`
	// Count asserts the total number of non-empty lines.
	Count *int `yaml:"count"`
}

// StateExpect is the on-disk half of a case.
type StateExpect struct {
	// Mode is "unchanged", "changed" or "ignored". It has no default:
	// a case that forgets it is refused by the loader, because an
	// unasserted dimension is exactly where a regression hides.
	Mode         string   `yaml:"mode"`
	FilesPresent []string `yaml:"files_present"`
	FilesAbsent  []string `yaml:"files_absent"`
}

func (s *Stream) UnmarshalYAML(node *yaml.Node) error {
	if node.Kind == yaml.ScalarNode {
		switch node.Value {
		case "empty", "ignored":
			s.Mode = node.Value
			return nil
		default:
			return fmt.Errorf("line %d: a stream is either `empty`, `ignored`, or a list of matchers (got %q)", node.Line, node.Value)
		}
	}
	if node.Kind != yaml.SequenceNode {
		return fmt.Errorf("line %d: a stream is either `empty`, `ignored`, or a list of matchers", node.Line)
	}
	s.Mode = "matchers"
	return node.Decode(&s.Matchers)
}

func (s *StateExpect) UnmarshalYAML(node *yaml.Node) error {
	if node.Kind == yaml.ScalarNode {
		s.Mode = node.Value
		return nil
	}
	type raw StateExpect
	var r raw
	if err := node.Decode(&r); err != nil {
		return err
	}
	*s = StateExpect(r)
	return nil
}

// LoadCases reads every *.yaml under root.
func LoadCases(root string) ([]Case, error) {
	var out []Case
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || filepath.Ext(path) != ".yaml" {
			return nil
		}
		c, err := LoadCase(root, path)
		if err != nil {
			return err
		}
		out = append(out, c)
		return nil
	})
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, err
}

// LoadCase reads and validates one case file.
func LoadCase(root, path string) (Case, error) {
	var c Case
	raw, err := os.ReadFile(path)
	if err != nil {
		return c, err
	}
	dec := yaml.NewDecoder(strings.NewReader(string(raw)))
	dec.KnownFields(true)
	if err := dec.Decode(&c); err != nil {
		return c, fmt.Errorf("%s: %w", path, err)
	}
	rel, err := filepath.Rel(root, path)
	if err != nil {
		rel = path
	}
	c.Path = path
	c.Name = strings.TrimSuffix(filepath.ToSlash(rel), ".yaml")
	return c, c.validate()
}

// validate refuses a case that would assert less than it looks like it
// asserts. Each rule here exists because the alternative failure is
// silent: a case with no argv runs nothing, a case with no state mode
// leaves the dimension a mutation would show up in unchecked, and a case
// with no contract reference is a snapshot wearing a contract's clothes.
func (c Case) validate() error {
	if len(c.Argv) == 0 && !c.NoArguments {
		return fmt.Errorf("%s: argv is required (set no_arguments: true if invoking with none is the point)", c.Name)
	}
	if c.Stdout.Mode == "" {
		return fmt.Errorf("%s: stdout is required (use `ignored` deliberately if it truly is)", c.Name)
	}
	if c.Stderr.Mode == "" {
		return fmt.Errorf("%s: stderr is required (use `ignored` deliberately if it truly is)", c.Name)
	}
	switch c.State.Mode {
	case "unchanged", "changed", "ignored":
	case "":
		return fmt.Errorf("%s: state is required (unchanged, changed or ignored)", c.Name)
	default:
		return fmt.Errorf("%s: unsupported state mode %q", c.Name, c.State.Mode)
	}
	for _, d := range c.KnownDiscrepancyDimensions {
		if !isDimension(d) {
			return fmt.Errorf("%s: known_discrepancy_dimensions: %q is not one of exit, stdout, stderr, state", c.Name, d)
		}
	}
	if len(c.KnownDiscrepancyDimensions) > 0 && c.KnownDiscrepancy == "" {
		return fmt.Errorf("%s: known_discrepancy_dimensions without a known_discrepancy issue reference", c.Name)
	}
	if c.InvokeAs != "" && (c.InvokeAs != filepath.Base(c.InvokeAs) || c.InvokeAs == "." || c.InvokeAs == "..") {
		return fmt.Errorf("%s: invoke_as %q: expected a bare filename, not a path", c.Name, c.InvokeAs)
	}
	if len(c.Contract) == 0 {
		return fmt.Errorf("%s: contract is required: name the document, FR number or usage text this expectation came from", c.Name)
	}
	for i, m := range append(append([]Matcher{}, c.Stdout.Matchers...), c.Stderr.Matchers...) {
		if err := m.validate(); err != nil {
			return fmt.Errorf("%s: matcher %d: %w", c.Name, i, err)
		}
	}
	return nil
}

func (m Matcher) validate() error {
	set := 0
	for _, s := range []string{m.Line, m.Re, m.Contains, m.Absent} {
		if s != "" {
			set++
		}
	}
	if len(m.NDJSON) > 0 {
		set++
	}
	if m.Count != nil {
		set++
	}
	if set != 1 {
		return fmt.Errorf("exactly one of line, re, contains, absent, ndjson or count must be set (found %d)", set)
	}
	return nil
}

// HasTag reports whether the case carries tag.
func (c Case) HasTag(tag string) bool {
	for _, t := range c.Tags {
		if t == tag {
			return true
		}
	}
	return false
}

// ExpectedFailure reports whether a mismatch in dimension is the expected
// outcome for this case.
func (c Case) ExpectedFailure(dimension string) bool {
	if c.KnownDiscrepancy == "" {
		return false
	}
	if len(c.KnownDiscrepancyDimensions) == 0 {
		return true
	}
	for _, d := range c.KnownDiscrepancyDimensions {
		if d == dimension {
			return true
		}
	}
	return false
}

func isDimension(name string) bool {
	for _, d := range Dimensions {
		if d == name {
			return true
		}
	}
	return false
}
